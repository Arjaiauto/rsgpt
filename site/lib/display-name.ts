/** A first name as shown on screen: first letter capitalised ("arjun" -> "Arjun"). Display only: the stored name, the
    session and the login matching keep the name as typed. */
export function displayName(name: string): string {
  const [first = "", ...rest] = Array.from(name.trim());
  return first.toLocaleUpperCase() + rest.join("");
}
