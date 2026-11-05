// Validation for the couple's menu (meal choices feature).

import { cleanLine } from './text';

export const MENU_LIMITS = {
  courses: 5,
  optionsPerCourse: 12,
  courseName: 60,
  optionName: 100,
  description: 200,
};

export interface MenuInput {
  courses: {
    id: string | null;
    name: string;
    options: { id: string | null; name: string; description: string | null }[];
  }[];
}

const ID = /^[A-Za-z0-9-]{1,64}$/;

function idOrNull(value: unknown): string | null {
  return typeof value === 'string' && ID.test(value) ? value : null;
}

export function validateMenu(input: unknown): { value: MenuInput } | { error: string } {
  const raw = input && typeof input === 'object' ? (input as Record<string, unknown>) : null;
  if (!raw || !Array.isArray(raw.courses)) return { error: 'Malformed menu.' };
  if (raw.courses.length > MENU_LIMITS.courses) {
    return { error: `At most ${MENU_LIMITS.courses} courses.` };
  }

  const courses: MenuInput['courses'] = [];
  const courseNames = new Set<string>();
  for (const c of raw.courses as unknown[]) {
    const cr = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>;
    const name = cleanLine(cr.name, MENU_LIMITS.courseName);
    if (!name)
      return { error: `Every course needs a name (up to ${MENU_LIMITS.courseName} characters).` };
    if (courseNames.has(name.toLowerCase()))
      return { error: `There are two courses called "${name}".` };
    courseNames.add(name.toLowerCase());

    if (!Array.isArray(cr.options) || cr.options.length === 0) {
      return { error: `Add at least one option to "${name}".` };
    }
    if (cr.options.length > MENU_LIMITS.optionsPerCourse) {
      return { error: `"${name}" can have at most ${MENU_LIMITS.optionsPerCourse} options.` };
    }

    const options: MenuInput['courses'][number]['options'] = [];
    const optionNames = new Set<string>();
    for (const o of cr.options as unknown[]) {
      const or = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>;
      const optionName = cleanLine(or.name, MENU_LIMITS.optionName);
      if (!optionName) {
        return {
          error: `Every option in "${name}" needs a name (up to ${MENU_LIMITS.optionName} characters).`,
        };
      }
      if (optionNames.has(optionName.toLowerCase())) {
        return { error: `"${name}" lists "${optionName}" twice.` };
      }
      optionNames.add(optionName.toLowerCase());
      const description =
        or.description === undefined || or.description === null || or.description === ''
          ? null
          : cleanLine(or.description, MENU_LIMITS.description);
      if (
        or.description &&
        typeof or.description === 'string' &&
        or.description.trim() &&
        !description
      ) {
        return { error: `Descriptions must be under ${MENU_LIMITS.description} characters.` };
      }
      options.push({ id: idOrNull(or.id), name: optionName, description });
    }
    courses.push({ id: idOrNull(cr.id), name, options });
  }
  return { value: { courses } };
}
