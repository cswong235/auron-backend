CREATE TABLE IF NOT EXISTS users(
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    username VARCHAR(50) NOT NULL,
    display_name VARCHAR(50),
    avatar_url TEXT,
    current_streak INTEGER NOT NULL DEFAULT 0,
    highest_streak INTEGER NOT NULL DEFAULT 0,
    ai_consent_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT unique_username UNIQUE (username),
    CONSTRAINT chk_streaks CHECK (current_streak >= 0 AND highest_streak >= 0)
);

CREATE TABLE IF NOT EXISTS user_settings(
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    default_deduction VARCHAR(10) NOT NULL DEFAULT 'today',
    monthly_setup VARCHAR(20) NOT NULL DEFAULT 'always_prompt',
    default_overspend VARCHAR(10) NOT NULL DEFAULT 'next_day',
    default_income VARCHAR(10) NOT NULL DEFAULT 'today',
    default_currency CHAR(3) NOT NULL DEFAULT 'MYR',
    timezone VARCHAR(50) NOT NULL DEFAULT 'Asia/Kuala_Lumpur',
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT chk_default_deduction CHECK (default_deduction IN ('today', 'spread')),
    CONSTRAINT chk_monthly_setup CHECK (monthly_setup IN ('reuse_previous', 'always_prompt')),
    CONSTRAINT chk_default_overspend CHECK (default_overspend IN ('next_day', 'spread')),
    CONSTRAINT chk_default_income CHECK (default_income IN ('today', 'spread', 'wishlist'))
);

CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
    -- Cut to 41 characters so there's room for the extra 9 below, since usernames fit 50
    new_username VARCHAR(50) := left(split_part(NEW.email, '@', 1), 41);
BEGIN
    -- If the username is taken, add part of the user's id to make it different
    IF EXISTS (SELECT 1 FROM public.users WHERE username = new_username) THEN
        new_username := new_username || '_' || left(NEW.id::text, 8);
    END IF;

    INSERT INTO public.users (id, username)
    VALUES (NEW.id, new_username);
    INSERT INTO public.user_settings (user_id)
    VALUES (NEW.id);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

CREATE TABLE IF NOT EXISTS monthly_plans(
    id SERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    month DATE NOT NULL,
    allowance_input_amount NUMERIC(12,2) NOT NULL,
    allowance_input_currency CHAR(3) NOT NULL,
    allowance_myr NUMERIC(12,2) NOT NULL,
    carry_in_debt NUMERIC(12,2) NOT NULL DEFAULT 0,
    carry_out_debt NUMERIC(12,2) NOT NULL DEFAULT 0,
    budget_mode VARCHAR(10) NOT NULL,
    daily_amount NUMERIC(12,2) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT chk_month_first_day CHECK (EXTRACT(DAY FROM month) = 1),
    CONSTRAINT chk_budget_mode CHECK (budget_mode IN ('auto', 'manual')),
    CONSTRAINT chk_plan_amounts CHECK (
        allowance_input_amount >= 0 AND allowance_myr >= 0
        AND carry_in_debt >= 0 AND carry_out_debt >= 0 AND daily_amount >= 0
    ),
    CONSTRAINT unique_user_month UNIQUE (user_id, month)
);

CREATE TABLE IF NOT EXISTS daily_budgets(
    id SERIAL PRIMARY KEY,
    plan_id INTEGER NOT NULL REFERENCES monthly_plans(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    adjustment_total NUMERIC(12,2) NOT NULL DEFAULT 0,
    spent_total NUMERIC(12,2) NOT NULL DEFAULT 0,
    streak_kept BOOLEAN,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT chk_spent_total CHECK (spent_total >= 0),
    CONSTRAINT unique_user_date UNIQUE (user_id, date)
);

CREATE TABLE IF NOT EXISTS categories(
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) NOT NULL,
    type VARCHAR(10) NOT NULL DEFAULT 'expense',

    CONSTRAINT unique_category_name UNIQUE (name),
    CONSTRAINT chk_category_type CHECK (type IN ('expense', 'income', 'both'))
);

INSERT INTO categories (name, type) VALUES
    ('Food', 'expense'), ('Transportation', 'expense'), ('Entertainment', 'expense'), ('Shopping', 'expense'),
    ('Bills', 'expense'), ('Health', 'expense'), ('Education', 'expense'), ('Other', 'both'),
    ('Salary', 'income'), ('Refund', 'income'), ('Sales', 'income')
ON CONFLICT (name) DO NOTHING;

CREATE TABLE IF NOT EXISTS expenses(
    id SERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day_id INTEGER NOT NULL REFERENCES daily_budgets(id) ON DELETE CASCADE,
    category_id INTEGER NOT NULL REFERENCES categories(id),
    name VARCHAR(100) NOT NULL,
    description TEXT,
    input_amount NUMERIC(12,2) NOT NULL,
    input_currency CHAR(3) NOT NULL,
    amount_myr NUMERIC(12,2) NOT NULL,
    deduction_option VARCHAR(10) NOT NULL,
    overspend_option VARCHAR(10) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP WITH TIME ZONE,

    CONSTRAINT chk_expense_amounts CHECK (input_amount > 0 AND amount_myr > 0),
    CONSTRAINT chk_deduction_option CHECK (deduction_option IN ('today', 'spread')),
    CONSTRAINT chk_overspend_option CHECK (overspend_option IN ('next_day', 'spread'))
);

CREATE TABLE IF NOT EXISTS incomes(
    id SERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day_id INTEGER NOT NULL REFERENCES daily_budgets(id) ON DELETE CASCADE,
    category_id INTEGER NOT NULL REFERENCES categories(id),
    name VARCHAR(100) NOT NULL,
    description TEXT,
    input_amount NUMERIC(12,2) NOT NULL,
    input_currency CHAR(3) NOT NULL,
    amount_myr NUMERIC(12,2) NOT NULL,
    distribution VARCHAR(10) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT chk_income_amounts CHECK (input_amount > 0 AND amount_myr > 0),
    CONSTRAINT chk_distribution CHECK (distribution IN ('today', 'spread', 'wishlist'))
);

CREATE TABLE IF NOT EXISTS wishlist_items(
    id SERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category_id INTEGER REFERENCES categories(id),
    name VARCHAR(100) NOT NULL,
    description TEXT,
    input_amount NUMERIC(12,2) NOT NULL,
    input_currency CHAR(3) NOT NULL DEFAULT 'MYR',
    image_url TEXT,
    product_link TEXT,
    -- 1 = Top, 2 = High, 3 = Moderate, 4 = Low Desirability
    desirability SMALLINT NOT NULL,
    affordable_notified BOOLEAN NOT NULL DEFAULT FALSE,
    purchased_at TIMESTAMP WITH TIME ZONE,
    purchase_amount_myr NUMERIC(12,2),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT chk_wishlist_price CHECK (input_amount > 0),
    CONSTRAINT chk_desirability CHECK (desirability BETWEEN 1 AND 4),
    CONSTRAINT chk_purchase_pair CHECK (
        (purchased_at IS NULL) = (purchase_amount_myr IS NULL)
    )
);

CREATE TABLE IF NOT EXISTS friendships(
    id SERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    friend_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT chk_status CHECK (status IN ('pending', 'accepted', 'declined')),
    CONSTRAINT no_self_friendship CHECK (user_id <> friend_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS unique_friendship_pair
    ON friendships (LEAST(user_id, friend_id), GREATEST(user_id, friend_id));

CREATE TABLE IF NOT EXISTS ai_insights(
    id SERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    period VARCHAR(10) NOT NULL,
    content JSONB NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT chk_insight_period CHECK (period IN ('week', 'month'))
);

CREATE TABLE IF NOT EXISTS notifications(
    id SERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type VARCHAR(30) NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    read_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT chk_notification_type CHECK (
        type IN (
            'budget_75', 'budget_90', 'wishlist_affordable', 'friend_request',
            'streak_milestone', 'friend_overspent'
        )
    )
);

-- MYR is the pivot: 1 MYR = rate units of the currency.
-- To MYR: amount / rate. From MYR: amount_myr * rate. Other pairs go through MYR
CREATE TABLE IF NOT EXISTS exchange_rates(
    currency CHAR(3) PRIMARY KEY,
    rate NUMERIC(18,8) NOT NULL,
    rate_date DATE NOT NULL,
    fetched_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT chk_rate CHECK (rate > 0)
);

INSERT INTO exchange_rates (currency, rate, rate_date)
VALUES ('MYR', 1, CURRENT_DATE)
ON CONFLICT (currency) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_daily_budgets_plan ON daily_budgets (plan_id);
CREATE INDEX IF NOT EXISTS idx_expenses_day ON expenses (day_id);
CREATE INDEX IF NOT EXISTS idx_expenses_user_created ON expenses (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses (category_id);
CREATE INDEX IF NOT EXISTS idx_incomes_day ON incomes (day_id);
CREATE INDEX IF NOT EXISTS idx_incomes_category ON incomes (category_id);
CREATE INDEX IF NOT EXISTS idx_wishlist_user ON wishlist_items (user_id);
CREATE INDEX IF NOT EXISTS idx_friendships_friend ON friendships (friend_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications (user_id, read_at);
CREATE INDEX IF NOT EXISTS idx_ai_insights_user_created ON ai_insights (user_id, created_at);

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE monthly_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE incomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE wishlist_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE friendships ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_insights ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE exchange_rates ENABLE ROW LEVEL SECURITY;

-- Logged in users can upload to the wishlist image bucket
CREATE POLICY
  "Authenticated can upload wishlist images"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'wishlist-images'
);

-- Anyone can view the wishlist images
CREATE POLICY
  "Wishlist images are readable"
ON storage.objects
FOR SELECT
TO public
USING (
  bucket_id = 'wishlist-images'
);

-- Logged in users can upload to their own folder in the profile photo bucket
CREATE POLICY
  "Authenticated can upload profile photos"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'profile-photos'
);

-- Anyone can view the profile photos
CREATE POLICY
  "Profile photos are readable"
ON storage.objects
FOR SELECT
TO public
USING (
  bucket_id = 'profile-photos'
);