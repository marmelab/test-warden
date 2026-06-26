// Tiny in-memory todo list — vitest twin of the jest demo (ESM this time).
import { randomUUID } from "node:crypto";

export function createTodoList() {
  const items = [];
  return {
    add(title) {
      if (!title || !title.trim()) throw new Error("title required");
      const item = { id: randomUUID(), title: title.trim(), done: false };
      items.push(item);
      return item;
    },
    toggle(id) {
      const item = items.find((i) => i.id === id);
      if (!item) throw new Error(`no todo ${id}`);
      item.done = !item.done;
      return item;
    },
    remove(id) {
      const i = items.findIndex((x) => x.id === id);
      if (i === -1) return false;
      items.splice(i, 1);
      return true;
    },
    list({ done } = {}) {
      return done === undefined
        ? [...items]
        : items.filter((i) => i.done === done);
    },
    get remaining() {
      return items.filter((i) => !i.done).length;
    },
  };
}
