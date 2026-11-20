-- A researcher persona's focus may be up to 500 characters (researcher_personas.focus is TEXT and the API allows 500), but
-- createPersona also copies it to agents.focus, which was VARCHAR(200): a focus of 201 to 500 characters failed with a 500.
ALTER TABLE agents MODIFY focus VARCHAR(500) NULL;
