class TokenService:
    def refresh_token(self, raw: str) -> str:
        return raw.strip()


def issue_session_token() -> str:
    return "ok"
