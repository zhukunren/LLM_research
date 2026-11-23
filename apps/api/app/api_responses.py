import csv
from io import StringIO
from typing import Any

from fastapi import HTTPException
from fastapi.responses import StreamingResponse


def bad_request(message: str, status: int = 422, code: str = "invalid_request", details: Any = None):
    raise HTTPException(status_code=status, detail={"code": code, "message": message, "details": details})


def _csv_cell(value: Any) -> Any:
    if isinstance(value, str) and value.startswith(("=", "+", "-", "@", "\t", "\r")):
        return "'" + value
    return value


def csv_response(filename: str, rows: list[list[Any]]):
    output = StringIO(newline="")
    writer = csv.writer(output, lineterminator="\r\n")
    for row in rows:
        writer.writerow([_csv_cell(value) for value in row])
    content = "\ufeff" + output.getvalue()
    return StreamingResponse(iter([content]), media_type="text/csv; charset=utf-8", headers={"Content-Disposition": f'attachment; filename="{filename}"'})
