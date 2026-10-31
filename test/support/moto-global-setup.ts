import type { TestProject } from 'vitest/node';
import { startMoto } from './moto.ts';

declare module 'vitest' {
  export interface ProvidedContext {
    motoEndpoint: string;
  }
}

export default async function setup(project: TestProject) {
  const moto = await startMoto();
  project.provide('motoEndpoint', moto.endpoint);
  return () => moto.stop();
}
