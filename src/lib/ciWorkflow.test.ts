import { describe, it, expect } from 'vitest';
import { buildValidateWorkflowYaml, CI_WORKFLOW_PATH } from './ciWorkflow';

describe('buildValidateWorkflowYaml', () => {
  it('produces a workflow referencing the app id + the official AppInspect action', () => {
    const yaml = buildValidateWorkflowYaml('TA_acme_logs');
    expect(CI_WORKFLOW_PATH).toBe('.github/workflows/build-validate.yml');
    expect(yaml).toMatch(/name: Build & Validate Splunk Add-on/);
    expect(yaml).toMatch(/ucc-gen build --source \./);
    expect(yaml).toMatch(/splunk\/appinspect-cli-action@v2\.13\.0/);
    expect(yaml).toContain('TA_acme_logs.tar.gz');
    expect(yaml).toMatch(/deploy-splunk-app-action/); // upgrade-path comment
  });

  it('sanitizes an unsafe app id', () => {
    const yaml = buildValidateWorkflowYaml('bad id/../x');
    expect(yaml).not.toMatch(/bad id|\.\.\//);
    expect(yaml).toContain('bad_id');
    expect(yaml).toContain('.tar.gz');
  });
});
