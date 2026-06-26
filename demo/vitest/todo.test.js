import { describe, test, expect, beforeEach } from "vitest";
import { createTodoList } from "./todo.js";

let todos;
beforeEach(() => {
  todos = createTodoList();
});

describe("add", () => {
  test("adds a todo with a unique uuid", () => {
    const a = todos.add("buy milk");
    expect(a).toMatchObject({ title: "buy milk", done: false });
    expect(a.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(todos.add("walk dog").id).not.toBe(a.id);
  });

  test("trims the title", () => {
    expect(todos.add("  spaced  ").title).toBe("spaced");
  });

  test("rejects an empty title", () => {
    expect(() => todos.add("   ")).toThrow("title required");
  });
});

describe("toggle", () => {
  test("flips done state", () => {
    const { id } = todos.add("task");
    expect(todos.toggle(id).done).toBe(true);
    expect(todos.toggle(id).done).toBe(false);
  });

  test("throws on unknown id", () => {
    expect(() => todos.toggle("nope")).toThrow("no todo nope");
  });
});

describe("remove", () => {
  test("removes an existing todo", () => {
    const { id } = todos.add("task");
    expect(todos.remove(id)).toBe(true);
    expect(todos.list()).toHaveLength(0);
  });

  test("returns false for a missing todo", () => {
    expect(todos.remove("missing")).toBe(false);
  });
});

describe("list & remaining", () => {
  test("filters by done state", () => {
    const a = todos.add("a");
    todos.add("b");
    todos.toggle(a.id);
    expect(todos.list({ done: true })).toHaveLength(1);
    expect(todos.list({ done: false })).toHaveLength(1);
  });

  test("counts remaining (not-done) todos", () => {
    const a = todos.add("a");
    todos.add("b");
    expect(todos.remaining).toBe(2);
    todos.toggle(a.id);
    expect(todos.remaining).toBe(1);
  });
});
