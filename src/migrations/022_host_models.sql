-- The models each CLI offers, as the CLI itself lists them: [{id, label, efforts}].
ALTER TABLE host_runtimes ADD COLUMN models JSON NULL;
