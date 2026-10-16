/**
 * Naming people and facilities (issue #18).
 *
 * `HELP.txt` § The Tenant Window: *"It also gives you the ability to name individual people in your
 * building"*; § Find Person: *"You can give names to a maximum of 20 people"*; § Find Tenant: *"The
 * number of named facilities is limited to 20"*; § Facility Window: *"The Rename button lets you
 * change the name of the facility to anything you like"*. The original's own refusals are
 * `STR 1005`: *"That name is too long.  Names can have up to 15 characters."*, *"You may only name
 * 20 people."*, *"You may only name 20 tenants."* - used word for word. The rename dialogs
 * (`DIALOG_730` / `732`: *"Rename | Cancel | Delete | Person's name:"*) have a Delete button, so
 * here an empty name is the same thing: it takes the name away.
 *
 * Names live on the tower (`tower.names`), plain JSON, so they travel in the save (v12). A name
 * is a **state change**, so it goes through `applyAction` (`name_person`, `name_facility`) like
 * everything else; the window never writes it.
 *
 * The limit counts names that still point at something. A person who left the tower, or a facility
 * that was demolished, is not "named" any more - `HELP.txt` says a named person can be found
 * *"assuming they are still in your tower"* - so those entries are dropped the next time anyone is
 * named, rather than holding a slot for ever. Pure and headless like the rest of `sim/`.
 */

export const MAX_NAMED_PEOPLE = 20;
export const MAX_NAMED_FACILITIES = 20;
export const MAX_NAME_LENGTH = 15;

/** `STR 1005`, verbatim (the double space after the first sentence is the original's). */
export const NAME_TEXT = {
  tooLong: 'That name is too long.  Names can have up to ' + MAX_NAME_LENGTH + ' characters.',
  tooManyPeople: 'You may only name ' + MAX_NAMED_PEOPLE + ' people.',
  tooManyTenants: 'You may only name ' + MAX_NAMED_FACILITIES + ' tenants.',
};

const refuse = (reason) => ({ ok: false, reason });

/** The name book. Absent on a tower that has never named anything, which reads as empty. */
export const namesOf = (tower) => tower.names ?? { people: {}, facilities: {} };

/**
 * A name as typed, made fit to keep: control characters out, runs of white space folded to one
 * space, the ends trimmed. (Length is checked after, so a name padded with spaces is not "too long".)
 */
export const cleanName = (raw) =>
  String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();

const actorExists = (tower, id) => tower.actors.some((a) => a && a.id === id);

/** Every name that still points at a living person: `[{ actorId, name }]`, in the order they were given. */
export function namedPeople(tower) {
  const out = [];
  for (const [key, name] of Object.entries(namesOf(tower).people)) {
    const actorId = Number(key);
    if (actorExists(tower, actorId)) out.push({ actorId, name });
  }
  return out;
}

/** Every name that still points at a standing facility: `[{ objectId, name }]`. */
export function namedFacilities(tower) {
  const out = [];
  for (const [key, name] of Object.entries(namesOf(tower).facilities)) {
    const objectId = Number(key);
    if (tower.objects.has(objectId)) out.push({ objectId, name });
  }
  return out;
}

export const personName = (tower, actorId) => namesOf(tower).people[actorId] ?? null;
export const facilityName = (tower, objectId) => namesOf(tower).facilities[objectId] ?? null;

/**
 * Why this person/facility cannot be given this name, or `null`. The window asks it before it
 * enables the button; `name_person` / `name_facility` ask it again - one definition.
 */
export function personNameRefusal(tower, actorId, raw) {
  if (!actorExists(tower, actorId)) return 'nobody there';
  const name = cleanName(raw);
  if (name.length > MAX_NAME_LENGTH) return NAME_TEXT.tooLong;
  if (name === '') return null;                                    // a delete is always allowed
  const book = namesOf(tower).people;
  const alreadyNamed = Object.hasOwn(book, actorId) && actorExists(tower, actorId);
  if (!alreadyNamed && namedPeople(tower).length >= MAX_NAMED_PEOPLE) return NAME_TEXT.tooManyPeople;
  return null;
}

export function facilityNameRefusal(tower, objectId, raw) {
  if (!tower.objects.has(objectId)) return 'nothing there';
  const name = cleanName(raw);
  if (name.length > MAX_NAME_LENGTH) return NAME_TEXT.tooLong;
  if (name === '') return null;
  const alreadyNamed = Object.hasOwn(namesOf(tower).facilities, objectId);
  if (!alreadyNamed && namedFacilities(tower).length >= MAX_NAMED_FACILITIES) return NAME_TEXT.tooManyTenants;
  return null;
}

function prune(tower) {
  const book = tower.names;
  for (const key of Object.keys(book.people)) if (!actorExists(tower, Number(key))) delete book.people[key];
  for (const key of Object.keys(book.facilities)) if (!tower.objects.has(Number(key))) delete book.facilities[key];
}

/** Name (or, with an empty name, un-name) a person. The state change behind `name_person`. */
export function namePerson(tower, actorId, raw) {
  const why = personNameRefusal(tower, actorId, raw);
  if (why) return refuse(why);
  tower.names ??= { people: {}, facilities: {} };
  prune(tower);
  const name = cleanName(raw);
  if (name === '') delete tower.names.people[actorId]; else tower.names.people[actorId] = name;
  return { ok: true, name: name === '' ? null : name };
}

/** Name (or un-name) a facility. The state change behind `name_facility`. */
export function nameFacility(tower, objectId, raw) {
  const why = facilityNameRefusal(tower, objectId, raw);
  if (why) return refuse(why);
  tower.names ??= { people: {}, facilities: {} };
  prune(tower);
  const name = cleanName(raw);
  if (name === '') delete tower.names.facilities[objectId]; else tower.names.facilities[objectId] = name;
  return { ok: true, name: name === '' ? null : name };
}
