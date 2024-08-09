import hre from "hardhat";

export class Tracing {
  public static enable() {
    hre.tracer.enabled = true;
  }

  public static disable() {
    hre.tracer.enabled = false;
  }

  get tracer() {
    return hre.tracer;
  }
}
