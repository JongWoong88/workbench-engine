// 순수 모델 모듈의 오류. bin/은 이것을 Rejection으로 감싸고, 보드 화면는 화면 경고로 보인다.
export class ParseError extends Error {
  /** @param {{ code: string, message: string, problems?: string[] }} o */
  constructor({ code, message, problems = [] }) {
    super(message);
    this.name = 'ParseError';
    Object.assign(this, { code, problems });
  }
}
