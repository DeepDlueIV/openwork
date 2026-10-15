import { expect } from "vitest";
import { test, needs } from "@openwork/testkit";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const moduleDir = resolve(import.meta.dirname, "../../infra/terraform/modules/openwork-aws-ecs");

test("AWS migration controller observes exactly one terminal task and fails closed on missing exit, rejection or deadline", async () => {
  needs({ commands: ["python3"] });
  const result = spawnSync("python3", ["-c", `
import importlib.util, json
spec = importlib.util.spec_from_file_location('migration', 'migration.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
event = {'cluster':'fixture', 'taskDefinition':'fixture:1', 'image':'fixture@sha256:abc', 'deployment':'initial', 'networkConfiguration':{}}
class ECS:
    def __init__(self, states, rejected=False):
        self.states=iter(states); self.calls=[]; self.rejected=rejected
    def run_task(self, **kw):
        self.calls.append(('run',kw))
        return {'tasks':[]} if self.rejected else {'tasks':[{'taskArn':'fixture-task'}]}
    def describe_tasks(self, **kw):
        self.calls.append(('describe',kw)); return {'tasks':[next(self.states)]}
    def stop_task(self, **kw): self.calls.append(('stop',kw))
for code in [0, 1, None]:
    ecs=ECS([{'lastStatus':'RUNNING'}, {'lastStatus':'STOPPED','containers':[{'exitCode':code}]}])
    result=m.run(event,ecs,lambda:60000,lambda seconds:None)
    assert (result['exitCode']==0) == (code==0)
    assert len([c for c in ecs.calls if c[0]=='run'])==1
    assert ecs.calls[0][1]['count']==1
    assert result['taskArn']=='fixture-task' and result['image']==event['image']
ecs=ECS([],True); assert m.run(event,ecs,lambda:60000)['exitCode'] != 0
ecs=ECS([]); assert m.run(event,ecs,lambda:1000)['exitCode'] != 0
assert [c[0] for c in ecs.calls]==['run','stop']
first=ecs.calls[0][1]['clientToken']
ecs=ECS([]); m.run(event,ecs,lambda:1000)
assert first==ecs.calls[0][1]['clientToken']
print(json.dumps({'scenarios':6,'singleTask':True,'ambiguousOutcomePromotes':False}))
`], { cwd: moduleDir, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ scenarios: 6, singleTask: true, ambiguousOutcomePromotes: false });
  const services = readFileSync(resolve(moduleDir, "ecs.tf"), "utf8");
  expect(services.match(/depends_on = \[terraform_data\.migration_complete/g)).toHaveLength(2);
  expect(services).not.toContain('containerName = "migrate"');
});

// Both tools fail a real apply at the completion gate. Their test-language
// expect_failures differs for apply-time values, so the parent asserts exit 1
// rather than using Terraform-only override_during or state_key options.
test("Terraform and OpenTofu reject a failed migration before service rollout", { timeout: 600_000 }, async () => {
  needs({ commands: ["terraform", "tofu"] });
  for (const tool of ["terraform", "tofu"]) {
    const init = spawnSync(tool, ["init", "-backend=false", "-input=false", "-upgrade", "-no-color"], { cwd: moduleDir, encoding: "utf8", timeout: 240_000 });
    expect(init.status, init.stderr).toBe(0);
    const negative = spawnSync(tool, ["test", "-no-color", "-test-directory=tests/negative"], { cwd: moduleDir, encoding: "utf8", timeout: 240_000 });
    expect(negative.status).toBe(1);
    expect((negative.stdout + negative.stderr).replace(/\s+/g, " ")).toContain("No service rollout is permitted");
    expect(negative.stdout + negative.stderr).not.toContain("Missing expected failure");
  }
});
