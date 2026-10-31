// A profile change must not race a funding transaction or an outgoing job mutation.
let transitioning = false;
let operations = 0;

export async function withSoapboxOperation<T>(run: () => Promise<T>): Promise<T> {
  if (transitioning)
    throw new Error("Compute profile is changing; wait for the gateway to reconnect");
  operations++;
  try {
    return await run();
  } finally {
    operations--;
  }
}

export function beginSoapboxTransition(): () => void {
  if (transitioning || operations)
    throw new Error("Compute is busy; wait for current operations to finish");
  transitioning = true;
  return () => {
    transitioning = false;
  };
}
