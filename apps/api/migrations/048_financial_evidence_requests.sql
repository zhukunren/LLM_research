CREATE UNIQUE INDEX financial_evidence_request ON financial_evidence_links(
    fact_id, json_extract(payload_json,'$.request_id')
) WHERE json_extract(payload_json,'$.request_id') IS NOT NULL;
