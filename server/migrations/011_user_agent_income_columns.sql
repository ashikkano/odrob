ALTER TABLE user_agents ADD COLUMN fee_income REAL DEFAULT 0;
ALTER TABLE user_agents ADD COLUMN dividend_income REAL DEFAULT 0;
ALTER TABLE user_agents ADD COLUMN royalty_income REAL DEFAULT 0;