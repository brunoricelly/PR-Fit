-- Revisão monotônica do documento principal. Reservada ao store (não aparece em loadAll()).
INSERT INTO meta(k, v) VALUES ('$db_rev', '0'::jsonb) ON CONFLICT (k) DO NOTHING;
