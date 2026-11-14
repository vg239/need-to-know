"""Run the stateless proxy. Access log is OFF so no request line or body is ever recorded."""

import os

import uvicorn

if __name__ == "__main__":
    uvicorn.run("app:app", host="127.0.0.1", port=int(os.environ.get("PORT", "8000")),
                access_log=False, log_level="warning")
