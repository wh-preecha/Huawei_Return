-- Huawei Return Management System
-- PostgreSQL 14+  (run against database huawei_return)
-- Documents follow the old return_cases model:
--   case id            return case (trash = body.deleted true, not a hard delete)
--   user~email         account (PBKDF2 hashVer 2 or 3 in body.pass / body.salt)
--   user~~index        { users: [email, ...] } signup order
-- history[] and thread[] stay inside the JSON document (arrayUnion appends).

CREATE TABLE IF NOT EXISTS sync_state (
  id  integer PRIMARY KEY,
  rev bigint  NOT NULL
);

INSERT INTO sync_state (id, rev) VALUES (1, 0)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS docs (
  id          text PRIMARY KEY,
  body        jsonb NOT NULL,
  rev         bigint NOT NULL,
  touched_at  timestamptz NOT NULL DEFAULT now(),
  kind        text GENERATED ALWAYS AS (
    CASE
      WHEN id = 'user~~index' THEN 'index'
      WHEN id LIKE 'user~%' THEN 'user'
      ELSE 'case'
    END
  ) STORED,
  deleted     boolean GENERATED ALWAYS AS (
    CASE WHEN body->'deleted' = 'true'::jsonb THEN true ELSE false END
  ) STORED,
  status      text GENERATED ALWAYS AS (body->>'status') STORED,
  invoice_no  text GENERATED ALWAYS AS (body->>'invoiceNo') STORED,
  order_no    text GENERATED ALWAYS AS (body->>'orderNo') STORED,
  pa_no       text GENERATED ALWAYS AS (body->>'paNo') STORED,
  ro_no       text GENERATED ALWAYS AS (body->>'roNo') STORED,
  cn_no       text GENERATED ALWAYS AS (body->>'cnNo') STORED,
  tracking    text GENERATED ALWAYS AS (body->>'tracking') STORED,
  return_tracking text GENERATED ALWAYS AS (body->>'returnTracking') STORED,
  serial      text GENERATED ALWAYS AS (body->>'serial') STORED,
  sku         text GENERATED ALWAYS AS (body->>'sku') STORED,
  cc_no       text GENERATED ALWAYS AS (body->>'ccNo') STORED,
  claim_no    text GENERATED ALWAYS AS (body->>'claimNo') STORED,
  platform    text GENERATED ALWAYS AS (body->>'platform') STORED,
  received_date text GENERATED ALWAYS AS (body->>'receivedDate') STORED,
  stock_date  text GENERATED ALWAYS AS (body->>'stockDate') STORED,
  created_at  text GENERATED ALWAYS AS (body->>'createdAt') STORED,
  updated_at  text GENERATED ALWAYS AS (body->>'updatedAt') STORED
);

CREATE INDEX IF NOT EXISTS docs_rev_id_idx ON docs (rev, id);
CREATE INDEX IF NOT EXISTS docs_kind_idx ON docs (kind);
CREATE INDEX IF NOT EXISTS docs_case_status_idx ON docs (status) WHERE kind = 'case';
CREATE INDEX IF NOT EXISTS docs_case_deleted_idx ON docs (deleted) WHERE kind = 'case';
CREATE INDEX IF NOT EXISTS docs_case_received_idx ON docs (received_date) WHERE kind = 'case';
CREATE INDEX IF NOT EXISTS docs_case_stock_idx ON docs (stock_date) WHERE kind = 'case';
CREATE INDEX IF NOT EXISTS docs_case_updated_idx ON docs (updated_at) WHERE kind = 'case';
CREATE INDEX IF NOT EXISTS docs_case_created_idx ON docs (created_at) WHERE kind = 'case';
CREATE INDEX IF NOT EXISTS docs_case_platform_idx ON docs (platform) WHERE kind = 'case';
CREATE INDEX IF NOT EXISTS docs_invoice_idx ON docs (lower(invoice_no));
CREATE INDEX IF NOT EXISTS docs_order_idx ON docs (lower(order_no));
CREATE INDEX IF NOT EXISTS docs_pa_idx ON docs (lower(pa_no));
CREATE INDEX IF NOT EXISTS docs_ro_idx ON docs (lower(ro_no));
CREATE INDEX IF NOT EXISTS docs_cn_idx ON docs (lower(cn_no));
CREATE INDEX IF NOT EXISTS docs_tracking_idx ON docs (lower(tracking));
CREATE INDEX IF NOT EXISTS docs_return_tracking_idx ON docs (lower(return_tracking));
CREATE INDEX IF NOT EXISTS docs_serial_idx ON docs (lower(serial));
CREATE INDEX IF NOT EXISTS docs_sku_idx ON docs (lower(sku));
CREATE INDEX IF NOT EXISTS docs_cc_idx ON docs (lower(cc_no));
CREATE INDEX IF NOT EXISTS docs_claim_idx ON docs (lower(claim_no));
-- Prefix scan (LIKE 'text%') needs text_pattern_ops. The default btree opclass follows the database collation and will not serve those searches.
CREATE INDEX IF NOT EXISTS docs_invoice_pattern_idx ON docs (lower(invoice_no) text_pattern_ops);
CREATE INDEX IF NOT EXISTS docs_order_pattern_idx ON docs (lower(order_no) text_pattern_ops);
CREATE INDEX IF NOT EXISTS docs_pa_pattern_idx ON docs (lower(pa_no) text_pattern_ops);
CREATE INDEX IF NOT EXISTS docs_ro_pattern_idx ON docs (lower(ro_no) text_pattern_ops);
CREATE INDEX IF NOT EXISTS docs_cn_pattern_idx ON docs (lower(cn_no) text_pattern_ops);
CREATE INDEX IF NOT EXISTS docs_tracking_pattern_idx ON docs (lower(tracking) text_pattern_ops);
CREATE INDEX IF NOT EXISTS docs_return_tracking_pattern_idx ON docs (lower(return_tracking) text_pattern_ops);
CREATE INDEX IF NOT EXISTS docs_serial_pattern_idx ON docs (lower(serial) text_pattern_ops);
CREATE INDEX IF NOT EXISTS docs_sku_pattern_idx ON docs (lower(sku) text_pattern_ops);
CREATE INDEX IF NOT EXISTS docs_cc_pattern_idx ON docs (lower(cc_no) text_pattern_ops);
CREATE INDEX IF NOT EXISTS docs_claim_pattern_idx ON docs (lower(claim_no) text_pattern_ops);

CREATE TABLE IF NOT EXISTS password_resets (
  token_hash text PRIMARY KEY,
  username   text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS password_resets_user_idx ON password_resets (username, created_at DESC);
