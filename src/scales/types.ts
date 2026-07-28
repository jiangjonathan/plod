export type Scale<TInput = unknown, TOutput = number> = {
  map(value: TInput): TOutput;
  invert?(value: TOutput): TInput;
};
