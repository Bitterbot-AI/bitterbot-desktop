/** An operational stop is not a candidate outcome and must not enter a paired score. */
export class LearningDispatchStopped extends Error {
  constructor(readonly reason: string) {
    super(`Automatic learning held: ${reason}`);
    this.name = "LearningDispatchStopped";
  }
}
