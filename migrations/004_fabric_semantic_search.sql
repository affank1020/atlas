CREATE TABLE fabric_semantic_documents (
  record_id uuid PRIMARY KEY REFERENCES records(id) ON DELETE CASCADE,
  model text NOT NULL,
  semantic_text text NOT NULL,
  embedding double precision[] NOT NULL,
  dimension integer NOT NULL CHECK (dimension > 0),
  source_updated_at timestamptz NOT NULL,
  indexed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fabric_semantic_documents_model_idx ON fabric_semantic_documents(model);

CREATE OR REPLACE FUNCTION fabric_cosine_similarity(a double precision[], b double precision[])
RETURNS double precision LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
SELECT CASE WHEN cardinality(a)<>cardinality(b) OR cardinality(a)=0 THEN NULL ELSE
  sum(a[i]*b[i]) / nullif(sqrt(sum(a[i]*a[i]))*sqrt(sum(b[i]*b[i])),0)
END FROM generate_subscripts(a,1) AS i;
$$;
