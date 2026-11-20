-- Research linked to an initiative (phase 5 of the initiative room, criterion 1): a research job (jobs.kind = research) on one of the
-- initiative's repositories. One job links to one initiative (the primary key of the job). Unlinking deletes the row; a citation
-- already stored keeps its job and version, and read_report refuses it afterwards.
CREATE TABLE initiative_reports (
  job_id VARCHAR(40) NOT NULL PRIMARY KEY,
  initiative_id VARCHAR(40) NOT NULL,
  linked_at DATETIME(3) NOT NULL,
  INDEX initiative_reports_initiative (initiative_id)
);
