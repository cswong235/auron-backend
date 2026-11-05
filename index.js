let express = require('express');
let path = require('path');
let app = express();

const { Pool } = require('pg');
require('dotenv').config();
const cors = require('cors');
const { supabase } = require('./supabaseClient');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});

app.use(cors());
app.use(express.json());

// Default route
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname + '/index.html'));
})

// Check that the server is up
app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

app.post('/signup', async (req, res) => {
    const { email, password } = req.body;
    const { data, error } = await supabase.auth.signUp({ email, password });
    if(error){
        if(error.message.includes("already registered")){
            return res.status(409).json({ error: "Email already in use." });
        }
        return res.status(400).json({ error: error.message });
    }

    res.status(201).json({ user: data.user, session: data.session });
});

app.post('/login', async (req, res) => {
    // Get the email and password from the input
    const {email, password} = req.body;
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if(error){
        return res.status(401).json({ error: error.message });
    }
    res.json({ session: data.session });
});

async function verifySession(req, res, next){
    const auth = req.headers.authorization;
    if(!auth){
        return res.status(401).end();
    }

    const token = auth.split(" ")[1];
    const { data, error } = await supabase.auth.getUser(token);

    if(error || !data.user){
        return res.status(401).end();
    }

    req.user = {
        userId: data.user.id,
        email: data.user.email,
    };

    next();
}

app.get('/users', verifySession, async (req, res) => {
    // Select all users except for the one you log in as
    try{
        const result = await pool.query(`
            SELECT id, username, created_at FROM users
            WHERE id <> $1
        `, [req.user.userId]);
        res.json(result.rows);
    }catch(err){
        console.error(err);
        res.status(500).json({ error: "Something went wrong, please check back again later.", err });
    }
});

// Get your profile data
app.get('/profile', verifySession, async (req, res) => {
    try{
        const result = await pool.query(`
            SELECT id, username, created_at FROM users
            WHERE id = $1
        `, [req.user.userId]);
        res.json(result.rows[0]);
    }catch(err){
        console.error(err);
        res.status(500).json({ error: "Something went wrong, please check back again later.", err });
    }
});

// Get the user's settings
app.get('/settings', verifySession, async (req, res) => {
    try{
        const result = await pool.query(`
            SELECT * FROM user_settings
            WHERE user_id = $1
        `, [req.user.userId]);
        res.json(result.rows[0]);
    }catch(err){
        console.error(err);
        res.status(500).json({ error: "Something went wrong, please check back again later." });
    }
});

// Update the user's settings
// TODO: This only sets the user currency for now, need to add the rest of the settings
app.patch('/settings', verifySession, async (req, res) => {
    const { default_currency } = req.body;
    if(!default_currency || default_currency.length !== 3){
        return res.status(400).json({ error: "Invalid currency." });
    }

    try{
        const result = await pool.query(`
            UPDATE user_settings
            SET default_currency = $1, updated_at = NOW()
            WHERE user_id = $2
            RETURNING *
        `, [default_currency, req.user.userId]);
        res.json({ message: "Settings updated", result: result.rows[0] });
    }catch(err){
        console.error(err);
        res.status(500).json({ error: 'Something went wrong' });
    }
});

// Get the user's plan for a month, e.g. /monthly-plans/current?month=2026-10-01
// The frontend sends the month so it matches the user's local date
app.get('/monthly-plans/current', verifySession, async (req, res) => {
    const { month } = req.query;
    if(!month){
        return res.status(400).json({ error: "Month is missing." });
    }

    try{
        const result = await pool.query(`
            SELECT * FROM monthly_plans
            WHERE user_id = $1 AND month = $2
        `, [req.user.userId, month]);
        // null means the user hasn't set up this month yet
        res.json(result.rows[0] || null);
    }catch(err){
        console.error(err);
        res.status(500).json({ error: "Something went wrong, please check back again later." });
    }
});

// Get the allowance from the user's latest plan before a month, e.g. /monthly-plans/previous?month=2026-11-01
app.get('/monthly-plans/previous', verifySession, async (req, res) => {
    const { month } = req.query;
    if(!month){
        return res.status(400).json({ error: "Month is missing." });
    }

    try{
        const result = await pool.query(`
            SELECT p.allowance_input_amount, p.allowance_input_currency, p.allowance_myr,
                s.default_currency, r.rate
            FROM monthly_plans p
            JOIN user_settings s ON s.user_id = p.user_id
            LEFT JOIN exchange_rates r ON r.currency = s.default_currency
            WHERE p.user_id = $1 AND p.month < $2
            ORDER BY p.month DESC
            LIMIT 1
        `, [req.user.userId, month]);

        // No earlier plan means this is a brand new user
        if(result.rows.length === 0){
            return res.json(null);
        }
        const plan = result.rows[0];

        // Use the allowance as it was typed if it's in the user's currency,
        // otherwise convert the MYR amount at today's rate
        let allowance = Number(plan.allowance_input_amount);
        if(plan.allowance_input_currency !== plan.default_currency){
            allowance = Math.round(Number(plan.allowance_myr) * Number(plan.rate) * 100) / 100;
        }

        res.json({ allowance, currency: plan.default_currency });
    }catch(err){
        console.error(err);
        res.status(500).json({ error: "Something went wrong, please check back again later." });
    }
});

// Create this month's plan and one daily_budgets row for each day left in the month
// The allowance is typed in the user's currency, but the plan and days are stored in MYR
app.post('/monthly-plans', verifySession, async (req, res) => {
    const userId = req.user.userId;
    const { allowance, currency, budget_mode, daily_amount, today } = req.body;

    if(!allowance || !currency || !budget_mode || !today){
        return res.status(400).json({ error: "One or some fields are empty." });
    }
    if(isNaN(allowance) || allowance <= 0){
        return res.status(400).json({ error: "Invalid allowance value." });
    }

    // Count the days left in the month, including today
    // today looks like "2026-10-31"
    const [year, month, day] = today.split('-').map(Number);
    const daysInMonth = new Date(year, month, 0).getDate();
    const daysLeft = daysInMonth - day + 1;

    // The amounts as the user typed them, in cents of their currency
    // NOTE: Cents are used due to how JavaScript inconsistently handles decimal numbers
    // Any further calculation like totalling or currency conversion has to be done in cents so no extra amount is added or lost
    // Example, Math.floor rounds down to the nearest whole number, meaning inconsistent decimals cause extra money to get lost
    // After calculation, it's converted back to 2 places to be stored
    const allowanceCents = Math.round(allowance * 100);
    const inputDailyCents = Math.round(daily_amount * 100);

    // Check the manual daily budget in the user's currency
    if(budget_mode === 'manual' && (isNaN(inputDailyCents) || inputDailyCents <= 0 || inputDailyCents * daysLeft > allowanceCents)){
        return res.status(400).json({ error: "Your daily budget can't add up to more than your monthly allowance." });
    }

    const monthText = String(month).padStart(2, '0');
    const monthStart = `${year}-${monthText}-01`;

    try{
        // MYR is the pivot currency: 1 MYR = rate units of the other currency
        const rateResult = await pool.query(`
            SELECT rate FROM exchange_rates
            WHERE currency = $1
        `, [currency]);
        if(rateResult.rows.length === 0){
            return res.status(400).json({ error: `There's no exchange rate for ${currency} yet.` });
        }
        const rate = Number(rateResult.rows[0].rate);

        // Convert to MYR, and work in cents so the daily amounts add up to the allowance exactly
        const allowanceMyrCents = Math.round(allowanceCents / rate);
        let dailyCents;
        let leftoverCents = 0;

        if(budget_mode === 'auto'){
            // Split evenly, rounding down, then hand out the leftover cents
            // one at a time to the first few days
            dailyCents = Math.floor(allowanceMyrCents / daysLeft);
            leftoverCents = allowanceMyrCents - dailyCents * daysLeft;
        }else{
            // Round down so the days can't add up to more than the allowance after converting
            dailyCents = Math.floor(inputDailyCents / rate);
        }

        const planResult = await pool.query(`
            INSERT INTO monthly_plans (user_id, month, allowance_input_amount, allowance_input_currency,
                allowance_myr, budget_mode, daily_amount)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING *
        `, [userId, monthStart, allowanceCents / 100, currency, allowanceMyrCents / 100, budget_mode, dailyCents / 100]);
        const plan = planResult.rows[0];

        // Build the insert values to insert multiple parts of data in one go
        // e.g. VALUES ($1, $2, $3, $4), ($5, $6, $7, $8), ...
        const values = [];
        const rows = [];
        for(let i = 0; i < daysLeft; i++){
            const date = `${year}-${monthText}-${String(day + i).padStart(2, '0')}`;
            const adjustment = i < leftoverCents ? 0.01 : 0;
            values.push(plan.id, userId, date, adjustment);

            const n = i * 4;
            rows.push(`($${n + 1}, $${n + 2}, $${n + 3}, $${n + 4})`);
        }

        await pool.query(`
            INSERT INTO daily_budgets (plan_id, user_id, date, adjustment_total)
            VALUES ${rows.join(', ')}
        `, values);

        res.status(201).json({ message: "Monthly plan created", result: plan });
    }catch(err){
        console.error(err);
        res.status(500).json({ error: 'Something went wrong' });
    }
});

// Get every day of a month, newest first, e.g. /daily-budgets?month=2026-10-01
app.get('/daily-budgets', verifySession, async (req, res) => {
    const { month } = req.query;
    if(!month){
        return res.status(400).json({ error: "Month is missing." });
    }

    try{
        // remaining = the daily budget + any adjustments - what was spent
        const result = await pool.query(`
            SELECT d.id, to_char(d.date, 'YYYY-MM-DD') AS date, d.adjustment_total, d.spent_total,
                d.streak_kept, p.daily_amount,
                p.daily_amount + d.adjustment_total - d.spent_total AS remaining
            FROM daily_budgets d
            JOIN monthly_plans p ON d.plan_id = p.id
            WHERE d.user_id = $1 AND p.month = $2
            ORDER BY d.date DESC
        `, [req.user.userId, month]);
        res.json(result.rows);
    }catch(err){
        console.error(err);
        res.status(500).json({ error: "Something went wrong, please check back again later." });
    }
});

// Get every day of the latest month with a plan before a month, newest first
// e.g. /daily-budgets/older?before=2026-11-01 gives August if September and October were skipped
app.get('/daily-budgets/older', verifySession, async (req, res) => {
    const { before } = req.query;
    if(!before){
        return res.status(400).json({ error: "Month is missing." });
    }

    try{
        // An empty list means there are no older plans
        const result = await pool.query(`
            SELECT d.id, to_char(d.date, 'YYYY-MM-DD') AS date, d.adjustment_total, d.spent_total,
                d.streak_kept, p.daily_amount,
                p.daily_amount + d.adjustment_total - d.spent_total AS remaining
            FROM daily_budgets d
            JOIN monthly_plans p ON d.plan_id = p.id
            WHERE d.user_id = $1 AND p.month = (
                SELECT MAX(month) FROM monthly_plans
                WHERE user_id = $1 AND month < $2
            )
            ORDER BY d.date DESC
        `, [req.user.userId, before]);
        res.json(result.rows);
    }catch(err){
        console.error(err);
        res.status(500).json({ error: "Something went wrong, please check back again later." });
    }
});

// Get the categories for a form, e.g. /categories?type=expense
// Categories marked as 'both' show up in either form
app.get('/categories', verifySession, async (req, res) => {
    const { type } = req.query;
    if(!['expense', 'income'].includes(type)){
        return res.status(400).json({ error: "Type must be either 'expense' or 'income'." });
    }

    try{
        const result = await pool.query(`
            SELECT id, name FROM categories
            WHERE type = $1 OR type = 'both'
            ORDER BY id
        `, [type]);
        res.json(result.rows);
    }catch(err){
        console.error(err);
        res.status(500).json({ error: "Something went wrong, please check back again later." });
    }
});

// Convert an amount to MYR, the pivot currency: 1 MYR = rate units of the other currency
// Gives back null if there's no rate for that currency yet
async function convertToMyr(amount, currency){
    const result = await pool.query(`
        SELECT rate FROM exchange_rates
        WHERE currency = $1
    `, [currency]);
    if(result.rows.length === 0){
        return null;
    }
    return Math.round(amount * 100 / Number(result.rows[0].rate)) / 100;
}

// Count the days left in a month, including today. The date looks like "2026-11-03"
function daysLeftInMonth(date){
    const [year, month, day] = date.split('-').map(Number);
    return new Date(year, month, 0).getDate() - day + 1;
}

// Check the fields used to create and edit an expense
function checkExpenseFields({ name, category_id, amount, currency, deduction_option }){
    if(!name || !category_id || !amount || !currency || !deduction_option){
        return "One or some fields are empty.";
    }
    if(isNaN(amount) || Math.round(amount * 100) <= 0){
        return "Invalid amount.";
    }
    return null;
}

// Apply an expense to the budget, or take it back off with a direction of -1
async function applyExpense(planId, date, amountMyr, deductionOption, direction){
    if(deductionOption === 'today'){
        await pool.query(`
            UPDATE daily_budgets
            SET spent_total = spent_total + $1, updated_at = NOW()
            WHERE plan_id = $2 AND date = $3
        `, [amountMyr * direction, planId, date]);
        return;
    }

    // Split evenly across this day and the rest of the month, rounding down, then hand out
    // the leftover cents one at a time to the first few days, like the monthly plan does
    const daysLeft = daysLeftInMonth(date);
    const amountCents = Math.round(amountMyr * 100);
    const shareCents = Math.floor(amountCents / daysLeft);
    const leftoverCents = amountCents - shareCents * daysLeft;

    // One query updates all of the days
    await pool.query(`
        UPDATE daily_budgets
        SET adjustment_total = adjustment_total
                - $1::numeric * ($2::numeric + CASE WHEN date < $3::date + $4::integer THEN 0.01 ELSE 0 END),
            updated_at = NOW()
        WHERE plan_id = $5 AND date >= $3::date
    `, [direction, shareCents / 100, date, leftoverCents, planId]);
}

// Find an expense to edit or delete, and whether its day is still today
async function findExpenseToChange(expenseId, userId){
    const result = await pool.query(`
        SELECT e.amount_myr, e.deduction_option, d.plan_id, to_char(d.date, 'YYYY-MM-DD') AS date,
            d.date = (NOW() AT TIME ZONE s.timezone)::date AS is_today
        FROM expenses e
        JOIN daily_budgets d ON e.day_id = d.id
        JOIN user_settings s ON s.user_id = e.user_id
        WHERE e.id = $1 AND e.user_id = $2 AND e.deleted_at IS NULL
    `, [expenseId, userId]);
    return result.rows[0];
}

// Get a day's expenses, newest first, e.g. /expenses?day_id=12
app.get('/expenses', verifySession, async (req, res) => {
    const { day_id } = req.query;
    if(!day_id){
        return res.status(400).json({ error: "Day is missing." });
    }

    try{
        const result = await pool.query(`
            SELECT e.id, e.category_id, c.name AS category_name, e.name, e.description, e.input_amount,
                e.input_currency, e.amount_myr, e.deduction_option, e.created_at
            FROM expenses e
            JOIN categories c ON e.category_id = c.id
            WHERE e.user_id = $1 AND e.day_id = $2 AND e.deleted_at IS NULL
            ORDER BY e.created_at DESC
        `, [req.user.userId, day_id]);
        res.json(result.rows);
    }catch(err){
        console.error(err);
        res.status(500).json({ error: "Something went wrong, please check back again later." });
    }
});

// Log an expense on today, the day in the user's timezone
app.post('/expenses', verifySession, async (req, res) => {
    const userId = req.user.userId;
    const { name, description, category_id, amount, currency, deduction_option } = req.body;

    const fieldError = checkExpenseFields(req.body);
    if(fieldError){
        return res.status(400).json({ error: fieldError });
    }

    try{
        const amountMyr = await convertToMyr(amount, currency);
        if(amountMyr === null){
            return res.status(400).json({ error: `There's no exchange rate for ${currency} yet.` });
        }

        const dayResult = await pool.query(`
            SELECT d.id, d.plan_id, to_char(d.date, 'YYYY-MM-DD') AS date, s.default_overspend
            FROM daily_budgets d
            JOIN user_settings s ON s.user_id = d.user_id
            WHERE d.user_id = $1 AND d.date = (NOW() AT TIME ZONE s.timezone)::date
        `, [userId]);
        if(dayResult.rows.length === 0){
            return res.status(400).json({ error: "There's no budget set up for today." });
        }
        const day = dayResult.rows[0];

        if(deduction_option === 'spread' && daysLeftInMonth(day.date) === 1){
            return res.status(400).json({ error: "You can't redistribute a cost on the last day of the month." });
        }

        const result = await pool.query(`
            INSERT INTO expenses (user_id, day_id, category_id, name, description, input_amount,
                input_currency, amount_myr, deduction_option, overspend_option)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            RETURNING *
        `, [userId, day.id, category_id, name, description || null, Math.round(amount * 100) / 100,
            currency, amountMyr, deduction_option, day.default_overspend]);
        await applyExpense(day.plan_id, day.date, amountMyr, deduction_option, 1);

        res.status(201).json({ message: "Expense added", result: result.rows[0] });
    }catch(err){
        console.error(err);
        res.status(500).json({ error: 'Something went wrong' });
    }
});

// Edit an expense
// Expenses are locked once their day ends
app.patch('/expenses/:id', verifySession, async (req, res) => {
    const { name, description, category_id, amount, currency, deduction_option } = req.body;

    const fieldError = checkExpenseFields(req.body);
    if(fieldError){
        return res.status(400).json({ error: fieldError });
    }

    try{
        const amountMyr = await convertToMyr(amount, currency);
        if(amountMyr === null){
            return res.status(400).json({ error: `There's no exchange rate for ${currency} yet.` });
        }

        const expense = await findExpenseToChange(req.params.id, req.user.userId);
        if(!expense){
            return res.status(404).json({ error: "Expense not found." });
        }
        if(!expense.is_today){
            return res.status(403).json({ error: "Expenses are locked once their day ends." });
        }
        if(deduction_option === 'spread' && daysLeftInMonth(expense.date) === 1){
            return res.status(400).json({ error: "You can't redistribute a cost on the last day of the month." });
        }

        // Take the old amount back off the budget, then apply the new one
        await applyExpense(expense.plan_id, expense.date, Number(expense.amount_myr), expense.deduction_option, -1);
        await applyExpense(expense.plan_id, expense.date, amountMyr, deduction_option, 1);

        const result = await pool.query(`
            UPDATE expenses
            SET category_id = $1, name = $2, description = $3, input_amount = $4, input_currency = $5,
                amount_myr = $6, deduction_option = $7, updated_at = NOW()
            WHERE id = $8
            RETURNING *
        `, [category_id, name, description || null, Math.round(amount * 100) / 100, currency,
            amountMyr, deduction_option, req.params.id]);

        res.json({ message: "Expense updated", result: result.rows[0] });
    }catch(err){
        console.error(err);
        res.status(500).json({ error: 'Something went wrong' });
    }
});

// Soft delete an expense
// Expenses are locked once their day ends
app.delete('/expenses/:id', verifySession, async (req, res) => {
    try{
        const expense = await findExpenseToChange(req.params.id, req.user.userId);
        if(!expense){
            return res.status(404).json({ error: "Expense not found." });
        }
        if(!expense.is_today){
            return res.status(403).json({ error: "Expenses are locked once their day ends." });
        }

        await pool.query(`
            UPDATE expenses
            SET deleted_at = NOW(), updated_at = NOW()
            WHERE id = $1
        `, [req.params.id]);
        await applyExpense(expense.plan_id, expense.date, Number(expense.amount_myr), expense.deduction_option, -1);

        res.json({ message: "Expense deleted" });
    }catch(err){
        console.error(err);
        res.status(500).json({ error: 'Something went wrong' });
    }
});

app.post('/friendships', verifySession, async (req, res) => {
    // Select all friendships
    const { friend_id } = req.body;
    try{
        const result = await pool.query(`
            INSERT INTO friendships (user_id, friend_id)
            VALUES ($1, $2)
            RETURNING *    
        `, [req.user.userId, friend_id]);
        res.status(201).json({ message: "Friend added successfully", result: result.rows[0] })
    }catch(err){
        console.error(err);
        res.status(500).json({ error: 'Something went wrong' });
    }
});

app.get('/friendships', verifySession, async (req, res) => {
    try{
        // Only return the people the logged in user is following
        const result = await pool.query(`
            SELECT * FROM friendships
            WHERE user_id = $1 OR friend_id = $1
        `, [req.user.userId]);
        res.json(result.rows);
    }catch(err){
        console.error(err);
        res.status(500).json({ error: "Something went wrong, please check back again later.", err });
    }
});

app.patch('/friendships/:id', verifySession, async (req, res) => {
    const { status } = req.body;

    // Only allow the frontend to accept or reject a request
    if(!['accepted', 'rejected'].includes(status)){
        return res.status(400).json({ error: "Status must be either 'accepted' or 'rejected'." });
    }

    try{
        const result = await pool.query(`
            UPDATE friendships
            SET status = $1
            WHERE id = $2 AND friend_id = $3 AND status = 'pending'
            RETURNING *
        `, [status, req.params.id, req.user.userId]);
        if(result.rows.length === 0){
            return res.status(404).json({ error: "No pending friend request found." });
        }
        res.json({ message: `Friend request ${status}`, result: result.rows[0] });
    }catch(err){
        console.error(err);
        res.status(500).json({ error: 'Something went wrong' });
    }
});

app.delete('/friendships/:id', verifySession, async (req, res) => {
    try{
        // Delete from the friendships table
        // Where the friend of a user_id is targeted and deleted
        const result = await pool.query(`
            DELETE FROM friendships
            WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)
            RETURNING *
        `, [req.user.userId, req.params.id]);
        if(result.rows.length === 0){
            return res.status(404).json({ error: "You are not following this user." });
        }
        res.json({ message: "Friend removed successfully", result: result.rows[0] });
    }catch(err){
        console.error(err);
        res.status(500).json({ error: 'Something went wrong' });
    }
});

// Middleware for invalid routes
app.use((req, res) => {
    res.status(404).json({ error: 'Route not found' });
});

// Only start the server when running "node index.js" directly,
// not when the tests require this file
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Auron API running on port ${PORT}`);
  });
}

module.exports = app;