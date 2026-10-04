// App-wide state: who is signed in and the household's lists (loaded once, refreshed on change).

export const state = {
  session: null,
  me: null, // { email, display_name, role, active, invited_at, joined_at }
  members: [], // everyone, deactivated people too (their entries keep their names)
  categories: [],
  subcategories: [],
  paymentMethods: [],
  incomeSources: [],
  receivingMethods: null, // where income comes in ("In"); null until its migration has run
  displayCurrency: "EGP", // the Dashboard's and Budget tab's EGP/USD switch (one setting for both)
};

export const byId = (list, id) => (id ? list.find((x) => x.id === id) || null : null);
export const shown = (list) => list.filter((x) => !x.hidden);
export const memberName = (email) =>
  state.members.find((m) => m.email === email)?.display_name || email || "";
// Who's in the household now (household-migration.sql adds active; before it, everyone is).
export const isActive = (m) => m.active !== false;
export const activeMembers = () => state.members.filter(isActive);
export const isOwner = () => state.me?.role === "owner";
export const subcategoriesOf = (categoryId) =>
  state.subcategories.filter((s) => s.category_id === categoryId);
