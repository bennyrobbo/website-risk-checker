# Website Risk Checker (AU)

Single-page site + API that evaluates e-commerce websites using a fixed scoring rubric.

## Structure
- `/app` = static frontend (HTML/CSS/JS)
- `/api/analyze` = Azure Function (HTTP POST)
- `/api/analyze/prompt.txt` = scoring prompt used by the function

## API
POST `/api/analyze`

Body:
```json
{ "url": "https://example.com" }
