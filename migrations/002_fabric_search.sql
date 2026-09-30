CREATE OR REPLACE FUNCTION fabric_flatten_jsonb(input jsonb)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
WITH RECURSIVE nodes(key, value) AS (
  SELECT ''::text, input
  UNION ALL
  SELECT child.key, child.value
  FROM nodes n
  CROSS JOIN LATERAL (
    SELECT e.key, e.value FROM jsonb_each(CASE WHEN jsonb_typeof(n.value)='object' THEN n.value ELSE '{}'::jsonb END) e
    UNION ALL
    SELECT ''::text, a.value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(n.value)='array' THEN n.value ELSE '[]'::jsonb END) a
  ) child
)
SELECT coalesce(string_agg(concat_ws(' ',nullif(lower(regexp_replace(regexp_replace(key,'([a-z0-9])([A-Z])','\1 \2','g'),'[_-]+',' ','g')),''),CASE jsonb_typeof(value) WHEN 'string' THEN value #>> '{}' WHEN 'null' THEN 'null' ELSE value::text END),' '),'')
FROM nodes WHERE jsonb_typeof(value) NOT IN ('object','array');
$$;

CREATE TABLE fabric_search_documents (
  record_id uuid PRIMARY KEY REFERENCES records(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  project_name text NOT NULL,
  store_name text NOT NULL,
  field_text text NOT NULL,
  searchable_text text NOT NULL,
  search_vector tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple',project_name || ' ' || store_name),'A') ||
    setweight(to_tsvector('simple',field_text),'B')
  ) STORED,
  source_updated_at timestamptz NOT NULL,
  indexed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fabric_search_documents_vector_idx ON fabric_search_documents USING gin(search_vector);
CREATE INDEX fabric_search_documents_project_idx ON fabric_search_documents(project_id);
CREATE INDEX fabric_search_documents_store_idx ON fabric_search_documents(store_id);
