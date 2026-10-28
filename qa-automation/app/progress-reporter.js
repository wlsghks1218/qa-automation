// 테스트 진행 상황을 한 줄씩 출력하는 Playwright 리포터 (앱이 읽어서 프로그레스 바로 표시)
//   [진행] 완료/전체 통과 실패
// 재시도하는 케이스는 마지막 시도가 끝났을 때 한 번만 센다.
class ProgressReporter {
  onBegin(config, suite) {
    this.total = suite.allTests().length;
    this.done = 0;
    this.passed = 0;
    this.failed = 0;
    this.print();
  }

  onTestEnd(test, result) {
    const last = result.status === 'passed' || result.status === 'skipped' || result.status === 'interrupted' || result.retry >= test.retries;
    if (!last) return;
    this.done++;
    const outcome = test.outcome();
    if (outcome === 'expected' || outcome === 'flaky') this.passed++;
    else if (outcome === 'unexpected') this.failed++;
    this.print();
  }

  print() {
    console.log(`[진행] ${this.done}/${this.total} ${this.passed} ${this.failed}`);
  }

  printsToStdio() {
    return false;
  }
}

module.exports = ProgressReporter;
