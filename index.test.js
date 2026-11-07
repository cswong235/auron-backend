const request = require("supertest");

// Mock Supabase client auth methods to prevent it from creating actual accounts
jest.mock("./supabaseClient", () => ({
  supabase: {
    auth: {
      signUp: jest.fn(),
      signInWithPassword: jest.fn(),
      getUser: jest.fn(),
    },
  },
}));

// Mock database connection and pool
jest.mock("pg", () => {
  const pool = { query: jest.fn() };
  return { Pool: jest.fn(() => pool) };
});

const app = require("./index");
const { supabase } = require("./supabaseClient");
const { Pool } = require("pg");
const pool = new Pool();

// Dummy data
const USER_ID = "11111111-1111-1111-1111-111111111111";
const EMAIL = "tester@example.com";
const PASSWORD = "password123";
const SESSION = { access_token: "fake-access-token", refresh_token: "fake-refresh-token" };
const AUTH = { Authorization: "Bearer fake-access-token" };

// Today is 3 November 2026, so there are 28 days left in the month counting today
const TODAY = "2026-11-03";
const PLAN_ID = 3;
const TODAY_ROW = { id: 7, plan_id: PLAN_ID, date: TODAY, default_overspend: "next_day" };

// What Frankfurter sends back: how much of each currency 1 MYR buys
const FRANKFURTER = {
  date: "2026-11-06",
  rates: { SGD: 0.31444, USD: 0.24606, EUR: 0.21839, GBP: 0.18227, JPY: 38.939, CNY: 1.6418, AUD: 0.35076, IDR: 4460.9, THB: 8.2775 },
};

beforeEach(() => {
  // Reset all mocks, including any queued database results a test didn't use up
  jest.resetAllMocks();
  // Nearly all routes call verifySession so mock the session as well
  supabase.auth.getUser.mockResolvedValue({
    data: { user: { id: USER_ID, email: EMAIL } },
    error: null,
  });
});

// Login and registration

test("POST /signup creates an account and returns a session", async () => {
  supabase.auth.signUp.mockResolvedValue({
    data: { user: { id: USER_ID, email: EMAIL }, session: SESSION },
    error: null,
  });

  const res = await request(app).post("/signup").send({ email: EMAIL, password: PASSWORD });
  console.log("1. POST /signup creates an account and returns a session:", res.statusCode, res.body);

  expect(res.statusCode).toBe(201);
  expect(res.body.session.access_token).toBe("fake-access-token");
});

test("POST /signup refuses an email that's already in use", async () => {
  supabase.auth.signUp.mockResolvedValue({
    data: { user: null, session: null },
    error: { message: "User already registered" },
  });

  const res = await request(app).post("/signup").send({ email: EMAIL, password: PASSWORD });
  console.log("2. POST /signup refuses an email that's already in use:", res.statusCode, res.body);

  expect(res.statusCode).toBe(409);
  expect(res.body.error).toBe("Email already in use.");
});

test("POST /login returns a session", async () => {
  supabase.auth.signInWithPassword.mockResolvedValue({
    data: { session: SESSION },
    error: null,
  });

  const res = await request(app).post("/login").send({ email: EMAIL, password: PASSWORD });
  console.log("3. POST /login returns a session:", res.statusCode, res.body);

  expect(res.statusCode).toBe(200);
  expect(res.body.session.access_token).toBe("fake-access-token");
});

test("POST /login refuses a wrong password", async () => {
  supabase.auth.signInWithPassword.mockResolvedValue({
    data: { session: null },
    error: { message: "Invalid login credentials" },
  });

  const res = await request(app).post("/login").send({ email: EMAIL, password: "wrong" });
  console.log("4. POST /login refuses a wrong password:", res.statusCode, res.body);

  expect(res.statusCode).toBe(401);
  expect(res.body.error).toBe("Invalid login credentials");
});

// Day display

test("GET /daily-budgets returns the month's days with what's left of each", async () => {
  pool.query.mockResolvedValueOnce({
    rows: [
      { id: 7, date: TODAY, remaining: "30.00" },
      { id: 6, date: "2026-11-02", remaining: "-5.00" },
    ],
  });

  const res = await request(app).get("/daily-budgets?month=2026-11-01").set(AUTH);
  console.log("5. GET /daily-budgets returns the month's days with what's left of each:", res.statusCode, res.body);

  expect(res.statusCode).toBe(200);
  expect(res.body).toHaveLength(2);
  expect(pool.query.mock.calls[0][0]).toContain("p.daily_amount + d.adjustment_total - d.spent_total AS remaining");
  expect(pool.query.mock.calls[0][1]).toEqual([USER_ID, "2026-11-01"]);
});

test("GET /daily-budgets refuses a request with no month", async () => {
  const res = await request(app).get("/daily-budgets").set(AUTH);
  console.log("6. GET /daily-budgets refuses a request with no month:", res.statusCode, res.body);

  expect(res.statusCode).toBe(400);
  expect(pool.query).not.toHaveBeenCalled();
});

test("GET /daily-budgets/older skips months the user didn't set up", async () => {
  pool.query.mockResolvedValueOnce({ rows: [{ id: 1, date: "2026-08-31", remaining: "10.00" }] });

  const res = await request(app).get("/daily-budgets/older?before=2026-11-01").set(AUTH);
  console.log("7. GET /daily-budgets/older skips months the user didn't set up:", res.statusCode, res.body);

  expect(res.statusCode).toBe(200);
  expect(res.body[0].date).toBe("2026-08-31");
  // It looks for the newest month with a plan, instead of just the month before
  expect(pool.query.mock.calls[0][0]).toContain("SELECT MAX(month) FROM monthly_plans");
});

// Expense logging

test("GET /expenses returns a day's expenses, leaving out deleted ones", async () => {
  pool.query.mockResolvedValueOnce({ rows: [{ id: 1, name: "Noodles", category_name: "Food", amount_myr: "10.00" }] });

  const res = await request(app).get("/expenses?day_id=7").set(AUTH);
  console.log("8. GET /expenses returns a day's expenses, leaving out deleted ones:", res.statusCode, res.body);

  expect(res.statusCode).toBe(200);
  expect(res.body[0].name).toBe("Noodles");
  expect(pool.query.mock.calls[0][0]).toContain("e.deleted_at IS NULL");
});

test("POST /expenses takes the amount off today's budget", async () => {
  pool.query
    .mockResolvedValueOnce({ rows: [{ rate: "1" }] }) // the MYR exchange rate
    .mockResolvedValueOnce({ rows: [TODAY_ROW] }) // today's row
    .mockResolvedValueOnce({ rows: [{ id: 1, name: "Noodles" }] }) // the saved expense
    .mockResolvedValueOnce({ rows: [] }); // the budget update

  const res = await request(app)
    .post("/expenses")
    .set(AUTH)
    .send({ name: "Noodles", category_id: 1, amount: 10, currency: "MYR", deduction_option: "today" });
  console.log("9. POST /expenses takes the amount off today's budget:", res.statusCode, res.body);

  expect(res.statusCode).toBe(201);
  expect(pool.query.mock.calls[3][0]).toContain("spent_total = spent_total + $1");
  expect(pool.query.mock.calls[3][1]).toEqual([10, PLAN_ID, TODAY]);
});

test("POST /expenses can redistribute the cost over the rest of the month", async () => {
  pool.query
    .mockResolvedValueOnce({ rows: [{ rate: "1" }] })
    .mockResolvedValueOnce({ rows: [TODAY_ROW] })
    .mockResolvedValueOnce({ rows: [{ id: 1, name: "Laptop stand" }] })
    .mockResolvedValueOnce({ rows: [] });

  const res = await request(app)
    .post("/expenses")
    .set(AUTH)
    .send({ name: "Laptop stand", category_id: 4, amount: 100, currency: "MYR", deduction_option: "spread" });
  console.log("10. POST /expenses can redistribute the cost over the rest of the month:", res.statusCode, res.body);

  expect(res.statusCode).toBe(201);
  // RM100 over 28 days is RM3.57 each, with the 4 leftover cents going to the first 4 days
  expect(pool.query.mock.calls[3][1]).toEqual([1, 3.57, TODAY, 4, PLAN_ID]);
});

test("POST /expenses refuses an expense with empty fields", async () => {
  const res = await request(app).post("/expenses").set(AUTH).send({ name: "", amount: 10 });
  console.log("11. POST /expenses refuses an expense with empty fields:", res.statusCode, res.body);

  expect(res.statusCode).toBe(400);
  expect(pool.query).not.toHaveBeenCalled();
});

test("PATCH /expenses/:id takes the old amount back off and applies the new one", async () => {
  pool.query
    .mockResolvedValueOnce({ rows: [{ rate: "1" }] })
    .mockResolvedValueOnce({
      rows: [{ amount_myr: "10.00", deduction_option: "today", plan_id: PLAN_ID, date: TODAY, is_today: true }],
    }) // the expense as it was
    .mockResolvedValueOnce({ rows: [] }) // undo the old amount
    .mockResolvedValueOnce({ rows: [] }) // apply the new amount
    .mockResolvedValueOnce({ rows: [{ id: 1, name: "Noodles", input_amount: "15.00" }] }); // the updated expense

  const res = await request(app)
    .patch("/expenses/1")
    .set(AUTH)
    .send({ name: "Noodles", category_id: 1, amount: 15, currency: "MYR", deduction_option: "today" });
  console.log("12. PATCH /expenses/:id takes the old amount back off and applies the new one:", res.statusCode, res.body);

  expect(res.statusCode).toBe(200);
  expect(pool.query.mock.calls[2][1]).toEqual([-10, PLAN_ID, TODAY]);
  expect(pool.query.mock.calls[3][1]).toEqual([15, PLAN_ID, TODAY]);
});

test("DELETE /expenses/:id marks the expense as deleted and gives the money back", async () => {
  pool.query
    .mockResolvedValueOnce({
      rows: [{ amount_myr: "10.00", deduction_option: "today", plan_id: PLAN_ID, date: TODAY, is_today: true }],
    })
    .mockResolvedValueOnce({ rows: [] }) // mark as deleted
    .mockResolvedValueOnce({ rows: [] }); // give the money back

  const res = await request(app).delete("/expenses/1").set(AUTH);
  console.log("13. DELETE /expenses/:id marks the expense as deleted and gives the money back:", res.statusCode, res.body);

  expect(res.statusCode).toBe(200);
  // A soft delete: the row stays and only gets marked
  expect(pool.query.mock.calls[1][0]).toContain("SET deleted_at = NOW()");
  expect(pool.query.mock.calls[2][1]).toEqual([-10, PLAN_ID, TODAY]);
});

test("DELETE /expenses/:id refuses an expense from a day that's over", async () => {
  pool.query.mockResolvedValueOnce({
    rows: [{ amount_myr: "10.00", deduction_option: "today", plan_id: PLAN_ID, date: "2026-11-02", is_today: false }],
  });

  const res = await request(app).delete("/expenses/1").set(AUTH);
  console.log("14. DELETE /expenses/:id refuses an expense from a day that's over:", res.statusCode, res.body);

  expect(res.statusCode).toBe(403);
  expect(pool.query).toHaveBeenCalledTimes(1);
});

// Income logging

test("POST /incomes adds the amount to today's budget", async () => {
  pool.query
    .mockResolvedValueOnce({ rows: [{ rate: "1" }] })
    .mockResolvedValueOnce({ rows: [TODAY_ROW] })
    .mockResolvedValueOnce({ rows: [{ id: 1, name: "Freelance" }] })
    .mockResolvedValueOnce({ rows: [] });

  const res = await request(app)
    .post("/incomes")
    .set(AUTH)
    .send({ name: "Freelance", category_id: 9, amount: 100, currency: "MYR", distribution: "today" });
  console.log("15. POST /incomes adds the amount to today's budget:", res.statusCode, res.body);

  expect(res.statusCode).toBe(201);
  expect(pool.query.mock.calls[2][0]).toContain("INSERT INTO incomes");
  expect(pool.query.mock.calls[3][0]).toContain("adjustment_total = adjustment_total + $1");
  expect(pool.query.mock.calls[3][1]).toEqual([100, PLAN_ID, TODAY]);
});

test("POST /incomes can distribute the amount over the rest of the month", async () => {
  pool.query
    .mockResolvedValueOnce({ rows: [{ rate: "1" }] })
    .mockResolvedValueOnce({ rows: [TODAY_ROW] })
    .mockResolvedValueOnce({ rows: [{ id: 1, name: "Freelance" }] })
    .mockResolvedValueOnce({ rows: [] });

  const res = await request(app)
    .post("/incomes")
    .set(AUTH)
    .send({ name: "Freelance", category_id: 9, amount: 100, currency: "MYR", distribution: "spread" });
  console.log("16. POST /incomes can distribute the amount over the rest of the month:", res.statusCode, res.body);

  expect(res.statusCode).toBe(201);
  // A direction of -1 adds each day's share on instead of taking it off
  expect(pool.query.mock.calls[3][1]).toEqual([-1, 3.57, TODAY, 4, PLAN_ID]);
});

test("POST /incomes refuses to distribute on the last day of the month", async () => {
  pool.query
    .mockResolvedValueOnce({ rows: [{ rate: "1" }] })
    .mockResolvedValueOnce({ rows: [{ id: 30, plan_id: PLAN_ID, date: "2026-11-30", default_overspend: "next_day" }] });

  const res = await request(app)
    .post("/incomes")
    .set(AUTH)
    .send({ name: "Freelance", category_id: 9, amount: 100, currency: "MYR", distribution: "spread" });
  console.log("17. POST /incomes refuses to distribute on the last day of the month:", res.statusCode, res.body);

  expect(res.statusCode).toBe(400);
  expect(pool.query).toHaveBeenCalledTimes(2);
});

test("POST /incomes refuses an income with empty fields", async () => {
  const res = await request(app).post("/incomes").set(AUTH).send({ name: "Freelance" });
  console.log("18. POST /incomes refuses an income with empty fields:", res.statusCode, res.body);

  expect(res.statusCode).toBe(400);
  expect(pool.query).not.toHaveBeenCalled();
});

// Currency conversion

test("POST /expenses in another currency keeps the original amount and saves it in MYR", async () => {
  pool.query
    .mockResolvedValueOnce({ rows: [{ rate: "0.31444" }] }) // 1 MYR buys S$0.31444
    .mockResolvedValueOnce({ rows: [TODAY_ROW] })
    .mockResolvedValueOnce({ rows: [{ id: 1, name: "Kaya toast" }] })
    .mockResolvedValueOnce({ rows: [] });

  const res = await request(app)
    .post("/expenses")
    .set(AUTH)
    .send({ name: "Kaya toast", category_id: 1, amount: 10, currency: "SGD", deduction_option: "today" });
  console.log("19. POST /expenses in another currency keeps the original amount and saves it in MYR:", res.statusCode, res.body);

  expect(res.statusCode).toBe(201);
  // S$10 / 0.31444 = RM31.80, while the original S$10 is kept too
  const saved = pool.query.mock.calls[2][1];
  expect(saved[5]).toBe(10);
  expect(saved[6]).toBe("SGD");
  expect(saved[7]).toBe(31.8);
  expect(pool.query.mock.calls[3][1]).toEqual([31.8, PLAN_ID, TODAY]);
});

test("POST /expenses refuses a currency that has no rate yet", async () => {
  pool.query.mockResolvedValueOnce({ rows: [] });

  const res = await request(app)
    .post("/expenses")
    .set(AUTH)
    .send({ name: "Pad thai", category_id: 1, amount: 50, currency: "THB", deduction_option: "today" });
  console.log("20. POST /expenses refuses a currency that has no rate yet:", res.statusCode, res.body);

  expect(res.statusCode).toBe(400);
  expect(res.body.error).toBe("There's no exchange rate for THB yet.");
});

test("GET /exchange-rates fetches the latest rates from Frankfurter the first time each day", async () => {
  global.fetch = jest.fn().mockResolvedValue({ json: async () => FRANKFURTER });
  pool.query
    .mockResolvedValueOnce({ rows: [] }) // nothing has been fetched yet today
    .mockResolvedValueOnce({ rows: [] }) // save the new rates
    .mockResolvedValueOnce({ rows: [{ currency: "SGD", rate: "0.31444000", rate_date: "2026-11-06" }] });

  const res = await request(app).get("/exchange-rates").set(AUTH);
  console.log("21. GET /exchange-rates fetches the latest rates from Frankfurter the first time each day:", res.statusCode, res.body);

  expect(res.statusCode).toBe(200);
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(global.fetch.mock.calls[0][0]).toContain("base=MYR");
  // All 9 currencies are saved in one query, with 3 values each
  expect(pool.query.mock.calls[1][0]).toContain("ON CONFLICT (currency) DO UPDATE");
  expect(pool.query.mock.calls[1][1]).toHaveLength(27);
  expect(pool.query.mock.calls[1][1].slice(0, 3)).toEqual(["SGD", 0.31444, "2026-11-06"]);
});

test("GET /exchange-rates doesn't fetch again later in the same day", async () => {
  global.fetch = jest.fn();
  pool.query
    .mockResolvedValueOnce({ rows: [{ currency: "USD" }] }) // already fetched today
    .mockResolvedValueOnce({ rows: [{ currency: "SGD", rate: "0.31444000", rate_date: "2026-11-06" }] });

  const res = await request(app).get("/exchange-rates").set(AUTH);
  console.log("22. GET /exchange-rates doesn't fetch again later in the same day:", res.statusCode, res.body);

  expect(res.statusCode).toBe(200);
  expect(global.fetch).not.toHaveBeenCalled();
  expect(res.body[0].currency).toBe("SGD");
});

test("GET /exchange-rates still sends the old rates when Frankfurter can't be reached", async () => {
  global.fetch = jest.fn().mockRejectedValue(new Error("Network down"));
  pool.query
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [{ currency: "SGD", rate: "0.31000000", rate_date: "2026-11-05" }] });

  const res = await request(app).get("/exchange-rates").set(AUTH);
  console.log("23. GET /exchange-rates still sends the old rates when Frankfurter can't be reached:", res.statusCode, res.body);

  expect(res.statusCode).toBe(200);
  expect(res.body[0].rate).toBe("0.31000000");
});
