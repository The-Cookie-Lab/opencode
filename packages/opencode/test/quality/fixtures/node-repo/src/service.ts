export class TokenService {
  refreshToken(input: string) {
    return input.trim()
  }
}

export function issueSessionToken() {
  return "ok"
}
