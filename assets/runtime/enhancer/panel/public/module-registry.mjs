const MODULE_ID = /^[a-z][a-z0-9-]{1,47}$/;

export class PanelModuleRegistry {
  constructor({ capabilities = [] } = {}) {
    this.capabilities = new Set(capabilities);
    this.modules = new Map();
    this.mounted = new Set();
  }

  register(module) {
    if (!module || typeof module !== "object" || !MODULE_ID.test(module.id || "")) {
      throw new Error("Invalid panel module id");
    }
    if (this.modules.has(module.id)) throw new Error(`Duplicate panel module: ${module.id}`);
    if (typeof module.label !== "string" || !module.label.trim()) throw new Error("Panel module label is required");
    if (typeof module.mount !== "function" || typeof module.destroy !== "function") {
      throw new Error("Panel module mount and destroy functions are required");
    }
    const requiredCapabilities = Array.isArray(module.requiredCapabilities)
      ? module.requiredCapabilities.filter((value) => typeof value === "string" && value)
      : [];
    this.modules.set(module.id, {
      ...module,
      label: module.label.trim(),
      order: Number.isFinite(module.order) ? module.order : 100,
      requiredCapabilities,
    });
    return this;
  }

  list() {
    return [...this.modules.values()]
      .filter((module) => module.requiredCapabilities.every((capability) => this.capabilities.has(capability)))
      .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  }

  async mount(id, context) {
    const module = this.list().find((candidate) => candidate.id === id);
    if (!module) throw new Error(`Panel module is unavailable: ${id}`);
    await module.mount(context);
    this.mounted.add(id);
  }

  async destroyAll() {
    const modules = [...this.modules.values()];
    for (const module of modules.reverse()) {
      if (this.mounted.has(module.id)) await module.destroy();
    }
    this.mounted.clear();
    this.modules.clear();
  }
}
