const { createTodoList } = require("./todo.js");

let todos;
beforeEach(() => {
  todos = createTodoList();
});

describe("add", () => {
  test("adds a todo with an incrementing id", () => {
    expect(todos.add("buy milk")).toEqual({
      id: 1,
      title: "buy milk",
      done: false,
    });
    expect(todos.add("walk dog").id).toBe(2);
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
    expect(() => todos.toggle(99)).toThrow("no todo 99");
  });
});

describe("remove", () => {
  test("removes an existing todo", () => {
    const { id } = todos.add("task");
    expect(todos.remove(id)).toBe(true);
    expect(todos.list()).toHaveLength(0);
  });

  test("returns false for a missing todo", () => {
    expect(todos.remove(123)).toBe(false);
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
