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