// Filtro One Euro (Casiez et al., CHI 2012): passa-basso con frequenza di taglio adattiva alla velocità.
// Lento → taglio basso (via il tremolio della mano); veloce → taglio alto (nessun ritardo percepito).

function alpha(cutoffHz: number, dtS: number) {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dtS);
}

export class OneEuroFilter {
  private x: number | null = null;
  private dx = 0;

  constructor(
    private minCutoff: number,
    private beta: number,
    private dCutoff = 1,
  ) {}

  reset() {
    this.x = null;
    this.dx = 0;
  }

  filter(value: number, dtS: number): number {
    if (this.x === null || dtS <= 0) {
      this.x = value;
      return value;
    }
    const rawDx = (value - this.x) / dtS;
    this.dx += alpha(this.dCutoff, dtS) * (rawDx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += alpha(cutoff, dtS) * (value - this.x);
    return this.x;
  }
}
