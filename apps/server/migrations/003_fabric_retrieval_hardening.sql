CREATE OR REPLACE FUNCTION fabric_searchable_jsonb(input jsonb)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
WITH RECURSIVE nodes(key, value) AS (
  SELECT ''::text, input
  UNION ALL
  SELECT child.key, child.value FROM nodes n CROSS JOIN LATERAL (
    SELECT e.key,e.value FROM jsonb_each(CASE WHEN jsonb_typeof(n.value)='object' THEN n.value ELSE '{}'::jsonb END)e
    UNION ALL SELECT ''::text,a.value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(n.value)='array' THEN n.value ELSE '[]'::jsonb END)a
  ) child
), scalars AS (
  SELECT lower(regexp_replace(regexp_replace(key,'([a-z0-9])([A-Z])','\1 \2','g'),'[_-]+',' ','g')) AS label,
    CASE jsonb_typeof(value) WHEN 'string' THEN value #>> '{}' ELSE value::text END AS raw_value,
    jsonb_typeof(value) AS value_type
  FROM nodes WHERE jsonb_typeof(value) NOT IN ('object','array','null')
)
SELECT coalesce(string_agg(concat_ws(' ',nullif(label,''),CASE
  WHEN value_type='null' THEN ''
  WHEN value_type='string' AND raw_value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN ''
  WHEN value_type='string' AND raw_value ~* '^https?://' THEN ''
  WHEN value_type='string' AND length(raw_value)>=24 AND raw_value !~ '[[:space:]]' AND raw_value ~ '[[:alpha:]]' AND raw_value ~ '[[:digit:]]' AND raw_value ~ '^[[:alnum:].:_-]+$' THEN ''
  ELSE raw_value END),' '),'') FROM scalars;
$$;

ALTER TABLE fabric_search_documents ADD COLUMN display_text text;
UPDATE fabric_search_documents SET display_text=field_text;
ALTER TABLE fabric_search_documents ALTER COLUMN display_text SET NOT NULL;
