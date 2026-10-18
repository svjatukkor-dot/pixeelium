INSERT OR IGNORE INTO users (sub, email, name, picture, created_at, last_login_at) VALUES ('test-user-alice','alice@example.com','Alice Tester','',1792311741275,1792311741275);
INSERT OR IGNORE INTO users (sub, email, name, picture, created_at, last_login_at) VALUES ('test-user-bob','bob@example.com','Bob Tester','',1792311741275,1792311741275);
INSERT OR IGNORE INTO sessions (token_hash, sub, created_at, expires_at, user_agent) VALUES ('60e9950e866a2d9a85cc450910098b064a9b36a8cc22b7e79317e023fb0cf313','test-user-alice',1792311741275,1794903741275,'smoke-test');
INSERT OR IGNORE INTO sessions (token_hash, sub, created_at, expires_at, user_agent) VALUES ('8438a8e12d3cc73929d55d434ddb0fbdbb5a5c2a5eb07911b4783e5df555d2b1','test-user-bob',1792311741275,1794903741275,'smoke-test');
