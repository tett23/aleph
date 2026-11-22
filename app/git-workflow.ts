import type { GitCredentials, GitLogin, IdentityKey, IdentityValue } from "./git-ipc.ts";

export const commitWithIdentity = async <T>(preflight: () => Promise<void>, save: () => Promise<unknown>, commit: () => Promise<T>) => {
  await preflight();
  await save();
  return commit();
};

export const validIdentity = (value: string) => !!value.trim() && !/[\r\n\0<>]/.test(value);
export const identityInputValid = (name: string, email: string, inherited?: Record<IdentityKey, IdentityValue | null>) =>
  [name, email].every((value, index) => value.trim() ? validIdentity(value) :
    !/[\r\n\0]/.test(value) && validIdentity(inherited?.[index === 0 ? "name" : "email"]?.value ?? ""));

export const withGitCredentials = async <T>(run: (credentials?: GitCredentials) => Promise<T>, prompt: () => Promise<GitLogin | null>) => {
  let target: string;
  try {
    return await run();
  } catch (failure) {
    if (typeof failure !== "object" || !failure || !("kind" in failure) || failure.kind !== "authRequired" ||
        !("authTarget" in failure) || typeof failure.authTarget !== "string") throw failure;
    target = failure.authTarget;
  }
  const credentials = await prompt();
  if (!credentials) throw { kind: "authentication", message: "Git の認証をキャンセルしました" };
  return run({ ...credentials, target });
};
