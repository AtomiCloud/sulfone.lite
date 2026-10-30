CREATE INDEX IF NOT EXISTS downloads_artifact_idx ON downloads (artifact_id);
CREATE INDEX IF NOT EXISTS likes_artifact_idx ON likes (artifact_id);
CREATE INDEX IF NOT EXISTS artifact_objects_ref_idx ON artifact_objects (object_key, sha256, size);
