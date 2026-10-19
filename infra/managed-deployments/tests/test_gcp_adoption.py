"""Offline managed GCP adoption/state/fence controls. No cloud credentials."""
import copy
from datetime import datetime, timedelta, timezone
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch

from test_gcp_installer import GCP, ROOT, ENV, runner, install


def observations(revision="owned-revision", count="0", stamp=None):
    stamp = stamp or datetime.now(timezone.utc)
    return {"timeSeries": [{"resource": {"labels": {"revision_name": revision}},
                            "metric": {"labels": {"state": state}},
                            "points": [{"interval": {"endTime": stamp.isoformat()},
                                        "value": {"int64Value": count}}]}
                           for state in ("active", "idle")]}


class AdoptionTests(unittest.TestCase):
    def test_native_historical_state_preserves_all_data_values(self):
        binary = shutil.which("terraform")
        self.assertIsNotNone(binary)
        result = subprocess.run([binary, "test", "-filter=tests/adoption.tftest.hcl", "-json", "-verbose"],
                                cwd=GCP / "terraform", capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        plans = {row["@testrun"]: row["test_plan"] for row in map(json.loads, result.stdout.splitlines())
                 if row.get("type") == "test_plan"}
        plan = plans["adopt_managed_data"]
        self.assertEqual(runner.unsafe_changes(plan), [])
        moved = [r for r in plan["resource_changes"] if r.get("previous_address")]
        self.assertEqual(len(moved), 19) # 4 generators, SQL instance/database/user, 4 secrets/versions/IAM
        for resource in moved:
            with self.subTest(resource=resource["address"]):
                change = resource["change"]
                self.assertNotIn("delete", change["actions"])
                self.assertEqual(change["before"]["id"], change["after"]["id"])
                if resource["type"] in {"random_password", "google_secret_manager_secret_version"}:
                    self.assertEqual(change["actions"], ["no-op"])
                    key = "result" if resource["type"] == "random_password" else "secret_data"
                    self.assertEqual(change["before"][key], change["after"][key])
                if resource["type"] == "google_sql_database_instance":
                    self.assertEqual(change["after"]["database_version"], "MYSQL_8_0")
                    self.assertEqual(change["after"]["name"], change["before"]["name"])

    def test_secret_updates_unknown_passwords_major_upgrades_and_service_replacement_are_blocked(self):
        for kind, change in [
            ("google_secret_manager_secret_version", {"actions": ["update"], "before": {}, "after": {}}),
            ("random_password", {"actions": ["delete", "create"], "before": {}, "after": {}}),
            ("google_sql_user", {"actions": ["update"], "before": {"password": "same"}, "after": {"password": "same"}, "after_unknown": {"password": True}}),
            ("google_sql_database_instance", {"actions": ["update"], "before": {"database_version": "MYSQL_8_0"}, "after": {"database_version": "MYSQL_8_4"}}),
            ("google_cloud_run_v2_service", {"actions": ["delete", "create"]}),
        ]:
            with self.subTest(kind=kind):
                self.assertEqual(runner.unsafe_changes({"resource_changes": [{"address": "owned", "type": kind, "change": change}]}), ["owned"])

    def test_apply_keeps_maintenance_through_migration_and_revision_validation(self):
        order = []
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            tf_root = root / "infra/managed-deployments/gcp/terraform"
            tf_root.mkdir(parents=True)
            def execute(command, **kwargs):
                if command[1] == "apply":
                    order.append(("apply", json.loads((tf_root / "managed.auto.tfvars.json").read_text()).get("managed_maintenance", False)))
            def checked(images):
                order.append(("verify", json.loads((tf_root / "managed.auto.tfvars.json").read_text())["managed_maintenance"]))
            with patch.dict(os.environ, ENV), patch.object(runner, "terraform_binary", return_value="terraform"), \
                    patch.object(runner, "maintenance_fence", return_value=True), patch.object(runner, "verify_maintained_revisions", side_effect=checked), \
                    patch.object(runner.subprocess, "run", side_effect=execute), patch.object(runner.subprocess, "check_output", return_value=b"{}"):
                runner.apply(root, {})
        self.assertEqual(order, [("apply", True), ("verify", True), ("apply", False)])

    def test_unverified_revisions_never_resume_autoscaling(self):
        calls = []
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "infra/managed-deployments/gcp/terraform").mkdir(parents=True)
            with patch.dict(os.environ, ENV), patch.object(runner, "terraform_binary", return_value="terraform"), \
                    patch.object(runner, "maintenance_fence", return_value=True), \
                    patch.object(runner, "verify_maintained_revisions", side_effect=ValueError("unverified")), \
                    patch.object(runner.subprocess, "run", side_effect=lambda command, **kw: calls.append(command)), \
                    patch.object(runner.subprocess, "check_output", return_value=b"{}"):
                with self.assertRaisesRegex(ValueError, "unverified"):
                    runner.apply(root, {})
            self.assertTrue(json.loads((root / "infra/managed-deployments/gcp/terraform/managed.auto.tfvars.json").read_text())["managed_maintenance"])
        self.assertEqual(sum(command[1] == "apply" for command in calls), 1)

    def test_only_disabled_pinned_latest_ready_api_only_revisions_can_resume(self):
        images = {"den_api": "api@sha256:" + "a" * 64, "den_web": "web@sha256:" + "b" * 64}
        def live(service):
            api = service.endswith("-api")
            revision = service + "-new"
            return {"metadata": {"name": service, "generation": 2, "annotations": {"run.googleapis.com/scalingMode": "manual", "run.googleapis.com/manualInstanceCount": "0"}},
                    "status": {"observedGeneration": 2, "latestReadyRevisionName": revision, "latestCreatedRevisionName": revision,
                               "traffic": [{"revisionName": revision, "percent": 100}]},
                    "spec": {"traffic": [{"percent": 100}], "template": {"metadata": {"name": revision}, "spec": {"containers": [{
                        "image": images["den_api" if api else "den_web"], "command": ["node"] if api else [],
                        "args": ["/app/ee/apps/den-api/dist/main.js"] if api else []}]}}}}
        with patch.dict(os.environ, ENV), patch.object(runner, "service_status", side_effect=live):
            runner.verify_maintained_revisions(images, timeout=0)
        reads = []
        def converging(service):
            result = live(service)
            if not reads:
                result["status"]["latestReadyRevisionName"] = "old"
            reads.append(service)
            return result
        with patch.dict(os.environ, ENV), patch.object(runner, "service_status", side_effect=converging), patch.object(runner.time, "sleep") as poll:
            runner.verify_maintained_revisions(images, timeout=10)
        self.assertEqual(len(reads), 3)
        poll.assert_called_once_with(3)
        for failure in ("old-ready", "split", "image", "command", "enabled"):
            def invalid(service):
                result = live(service)
                if failure == "old-ready":
                    result["status"]["latestReadyRevisionName"] = "old"
                elif failure == "split":
                    result["status"]["traffic"][0]["percent"] = 50
                elif failure == "image":
                    result["spec"]["template"]["spec"]["containers"][0]["image"] = "old"
                elif failure == "command":
                    result["spec"]["template"]["spec"]["containers"][0]["args"] = ["bootstrap.js"]
                else:
                    result["metadata"]["annotations"]["run.googleapis.com/scalingMode"] = "automatic"
                return result
            with self.subTest(failure=failure), patch.dict(os.environ, ENV), patch.object(runner, "service_status", side_effect=invalid):
                with self.assertRaises(ValueError):
                    runner.verify_maintained_revisions(images, timeout=0)

    def test_custom_observer_role_is_one_read_permission_not_monitoring_viewer(self):
        source = (GCP / "runner/install.py").read_text()
        self.assertIn("--permissions=monitoring.timeSeries.list", source)
        self.assertNotIn("roles/monitoring.viewer", install.RUNNER_ROLES)
        shared = ROOT / "infra/terraform/modules/openwork-gcp-cloud-run"
        self.assertIn("var.grant_iam_roles && !var.managed_legacy", (shared / "main.tf").read_text())

    def test_native_migration_is_not_executed_again_by_the_runner(self):
        source = (GCP / "runner/runner.py").read_text()
        apply_source = source[source.index("def apply("):source.index("def verify_services(")]
        self.assertNotIn('"jobs", "execute"', apply_source)
        self.assertNotIn("-target=", apply_source)
        self.assertIn('approved_plan("maintained-platform")', apply_source)


class CompletionWaitTests(unittest.TestCase):
    def test_service_readiness_observes_stale_pending_then_completed(self):
        stale = {"metadata": {"generation": 2}, "status": {"observedGeneration": 1, "conditions": [{"type": "Ready", "status": "True"}]}}
        pending = {"metadata": {"generation": 2}, "status": {"observedGeneration": 2, "conditions": [{"type": "Ready", "status": "Unknown"}]}}
        ready = {"metadata": {"generation": 2}, "status": {"observedGeneration": 2, "conditions": [{"type": "Ready", "status": "True"}]}}
        with patch.dict(os.environ, ENV), patch.object(runner, "gcloud", side_effect=[stale, pending, ready]) as cloud, patch.object(runner.time, "sleep") as poll:
            runner.verify_services({"service_names": {"den_api": "owned-api"}}, timeout=10)
        self.assertEqual(poll.call_count, 2)
        self.assertTrue(all(call.args[:3] == ("run", "services", "describe") for call in cloud.call_args_list))

    def test_previous_execution_is_observed_to_completion_without_execution_retry(self):
        completed = [{"status": {"completionTime": "known", "conditions": [{"type": "Completed", "status": "True"}]}}]
        with patch.dict(os.environ, ENV), patch.object(runner, "gcloud", side_effect=[[{"status": {}}], completed]) as cloud, patch.object(runner.time, "sleep") as poll:
            runner.verify_no_running_migration(timeout=10)
        poll.assert_called_once_with(3)
        self.assertTrue(all(call.args[:4] == ("run", "jobs", "executions", "list") for call in cloud.call_args_list))

    def test_pending_completion_has_a_monotonic_deadline(self):
        with patch.object(runner.time, "monotonic", side_effect=[0, 1, 5]), patch.object(runner.time, "sleep") as poll:
            with self.assertRaisesRegex(ValueError, "deadline"):
                runner.wait_for_completion(lambda: False, "deadline", timeout=5)
        poll.assert_called_once_with(3)


class FenceTests(unittest.TestCase):
    def plan(self):
        return {"prior_state": {"values": {"root_module": {"resources": [
            {"type": "google_cloud_run_v2_service", "values": {"name": "ow-123456781234" + suffix,
                "project": ENV["PROJECT_ID"], "location": ENV["REGION"]}} for suffix in ("-api", "-web")
        ]}}}}

    def test_empty_state_is_fresh_but_partial_or_wrong_target_is_not(self):
        with patch.dict(os.environ, ENV), patch.object(runner, "gcloud") as cloud:
            self.assertFalse(runner.maintenance_fence({}))
            plan = self.plan()
            plan["prior_state"]["values"]["root_module"]["resources"].pop()
            with self.assertRaisesRegex(ValueError, "ownership"):
                runner.maintenance_fence(plan)
            cloud.assert_not_called()

    def test_missing_stale_paginated_active_or_idle_instances_are_never_zero(self):
        since = datetime.now(timezone.utc) - timedelta(seconds=1)
        self.assertTrue(runner.drained_instances(observations(), since, {"owned-revision"}))
        for value in ({}, {"timeSeries": []}, {**observations(), "nextPageToken": "more"},
                      observations(count="1"), observations(stamp=since - timedelta(seconds=1)),
                      observations(revision="other"), {"timeSeries": observations()["timeSeries"][:1]}):
            with self.subTest(value=value):
                self.assertFalse(runner.drained_instances(value, since, {"owned-revision"}))

    def test_fence_clears_tags_disables_owned_services_then_waits_for_fresh_both_state_zeroes(self):
        disabled = set()
        order = []
        lagged = False
        def cloud(*args):
            nonlocal lagged
            if args[:3] == ("run", "jobs", "executions"):
                return []
            service = args[3]
            order.append(args[:3])
            if args[:3] == ("run", "services", "update"):
                self.assertIn("--scaling=0", args)
                disabled.add(service)
            if args[:3] == ("run", "services", "describe"):
                observed = 2
                if len(disabled) == 2 and not lagged:
                    lagged = True
                    observed = 1
                return {"metadata": {"name": service, "generation": 2, "annotations": {
                    "run.googleapis.com/scalingMode": "manual" if service in disabled else "automatic",
                    "run.googleapis.com/manualInstanceCount": "0"}},
                    "spec": {"traffic": [{"percent": 100}]},
                    "status": {"observedGeneration": observed, "traffic": [{"revisionName": service + "-r1"}]}}
            return {}
        def metrics(service, since):
            return observations(service + "-r1", "0" if len(disabled) == 2 else "1")
        with patch.dict(os.environ, ENV), patch.object(runner, "gcloud", side_effect=cloud), \
                patch.object(runner, "instance_observations", side_effect=metrics), patch.object(runner.time, "sleep") as poll:
            self.assertTrue(runner.maintenance_fence(self.plan()))
        self.assertTrue(lagged)
        poll.assert_called_once_with(3)
        self.assertEqual(len(disabled), 2)
        self.assertEqual(order.count(("run", "services", "update-traffic")), 2)
        self.assertNotIn(("run", "services", "delete"), order)

    def test_prior_running_unknown_or_malformed_migration_blocks_adoption(self):
        for executions in ({}, [{"status": {}}], [{"status": {"completionTime": "known", "conditions": [{"type": "Completed", "status": "Unknown"}]}}]):
            with patch.dict(os.environ, ENV), patch.object(runner, "gcloud", return_value=executions):
                with self.assertRaises(ValueError):
                    runner.verify_no_running_migration(timeout=0)
        for executions in ([], [{"status": {"completionTime": "known", "conditions": [{"type": "Completed", "status": "True"}]}}]):
            with patch.dict(os.environ, ENV), patch.object(runner, "gcloud", return_value=executions):
                runner.verify_no_running_migration(timeout=0)

    def test_tags_unobserved_generation_or_resumed_autoscaling_are_not_disabled(self):
        good = {"metadata": {"generation": 3, "annotations": {"run.googleapis.com/scalingMode": "manual", "run.googleapis.com/manualInstanceCount": "0"}},
                "status": {"observedGeneration": 3, "traffic": []}, "spec": {"traffic": [{"percent": 100}]}}
        self.assertTrue(runner.disabled_service(good))
        for field in ("tag", "generation", "scaling"):
            status = copy.deepcopy(good)
            if field == "tag":
                status["spec"]["traffic"][0]["tag"] = "legacy"
            elif field == "generation":
                status["status"]["observedGeneration"] = 2
            else:
                status["metadata"]["annotations"]["run.googleapis.com/scalingMode"] = "automatic"
            self.assertFalse(runner.disabled_service(status))


if __name__ == "__main__":
    unittest.main()
