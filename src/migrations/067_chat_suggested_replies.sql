-- The one-click replies an Architect offers the Client (D10, C-suggest-replies): up to four short texts, set by suggest_replies,
-- cleared by any message to the chat and by a wake. NULL when none. Operator chats never set it.
ALTER TABLE chats ADD COLUMN suggested_replies JSON NULL;
