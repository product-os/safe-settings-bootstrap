#!/usr/bin/env node
import dotenv from "dotenv";
dotenv.config();
import { Octokit } from "octokit";
import yaml from "yaml";
import fs from "fs";
import path from "path";

// Load the GitHub Personal Access Token and organization name from environment variables
const token = process.env.GITHUB_TOKEN;
const org = process.env.ORG_NAME;
const specificRepo = process.env.SPECIFIC_REPO; // Optionally set this to run on a single repo
const reposDir = path.join(process.cwd(), ".github", "repos");

// https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository#using-fnmatch-syntax
const protectedBranches = [
  {
    name: "Default",
    source: "~DEFAULT_BRANCH",
    include: "~DEFAULT_BRANCH",
  },
  {
    name: "ESR",
    source: "2024.7.x",
    include: "refs/heads/20[0-9][0-9].*.x",
  }
];

// Initialize Octokit with the GitHub token
const octokit = new Octokit({ auth: token });

async function processRepository(repoName) {
  let rulesets = [];
  let branches = [];

  // Fetch repository settings
  const repoData = await octokit.rest.repos.get({ owner: org, repo: repoName });

  if (repoData.data.archived) {
    // Skip archived repositories
    return;
  }

  if ([".github"].includes(repoData.data.name)) {
    // Skip the .github repository
    return;
  }

  console.log(`Processing repository: ${repoName}`);

  for (const branch of protectedBranches) {

    let protectionData = {
      data: {
        required_status_checks: {
          checks: [],
          strict: true,
        },
      }
    };

    // Attempt to fetch branch protection data for the provided
    // branch name. If the branch protection data is not found,
    // attempt to fetch the branch protection data for the default
    // branch of the repository.
    try {
      protectionData = await octokit.rest.repos.getBranchProtection({
        owner: org,
        repo: repoName,
        branch: branch.source,
      });
    } catch (error) {
      try {
        protectionData = await octokit.rest.repos.getBranchProtection({
          owner: org,
          repo: repoName,
          branch: repoData.data.default_branch,
        });
      } catch (error) {
        // ignore errors
      }
    }

    const rulesetData = protectionDataToRuleset(protectionData.data, branch);

    // Remove 'policy-bot' contexts and filter out rules without contexts
    rulesetData.rules = rulesetData.rules
      .map((rule) => {
        if (rule.type === "required_status_checks") {
          rule.parameters.required_status_checks =
            rule.parameters.required_status_checks.filter(
              (check) =>
                !check.context.startsWith("policy-bot") &&
                !check.context.startsWith("VersionBot") &&
                !check.context.startsWith("ResinCI") &&
                !check.context.startsWith("Flowzone")
            );
        }
        return rule;
      })
      .filter(
        (rule) =>
          !(
            rule.type === "required_status_checks" &&
            rule.parameters.required_status_checks.length === 0
          )
      );

    // Only push to rulesets if there are rules remaining after filters
    if (rulesetData.rules.length > 0) {
      rulesets.push(rulesetData);
    }
  }

  try {
    const repoRulesets = await octokit.rest.repos.getRepoRulesets({
      owner: org,
      repo: repoName,
      includes_parents: true,
    });

    repoRulesets.data = repoRulesets.data.filter(
      (ruleset) => !ruleset.name.startsWith("policy-bot:")
    );

    for (let i = 0; i < repoRulesets.data.length; ++i) {
      const rulesetResponse = await octokit.rest.repos.getRepoRuleset({
        owner: org,
        repo: repoName,
        ruleset_id: repoRulesets.data[i].id,
      });

      delete rulesetResponse.data.id;
      delete rulesetResponse.data.source;
      delete rulesetResponse.data.source_type;
      delete rulesetResponse.data.created_at;
      delete rulesetResponse.data.updated_at;
      delete rulesetResponse.data.node_id;
      delete rulesetResponse.data.current_user_can_bypass;
      delete rulesetResponse.data._links;

      // Filter out context checks starting with Flowzone
      rulesetResponse.data.rules = rulesetResponse.data.rules
      .map((rule) => {
        if (rule.type === "required_status_checks") {
          rule.parameters.required_status_checks =
            rule.parameters.required_status_checks.filter(
              (check) =>
                !check.context.startsWith("policy-bot") &&
                !check.context.startsWith("VersionBot") &&
                !check.context.startsWith("ResinCI") &&
                !check.context.startsWith("Flowzone")
            );
        }
        return rule;
      })
      .filter(
        (rule) =>
          !(
            rule.type === "required_status_checks" &&
            rule.parameters.required_status_checks.length === 0
          )
      );

      if (rulesetResponse.data.rules.length < 1) {
        // Skip rulesets without rules
        continue;
      }

      // Skip rulesets without required_status_checks
      if (
        !rulesetResponse.data.rules.some(
          (rule) => rule.type === "required_status_checks"
        )
      ) {
        continue;
      }

      if (rulesetResponse.data.name === "Default" && rulesetResponse.data.enforcement === "active") {
        // Remove branch protection for the default branch if an active ruleset exists
        branches.push({name: "default", protection: null});
      };

      if (rulesetResponse.data.name === "ESR" && rulesetResponse.data.enforcement === "active") {
        // Remove branch protection for the ESR branch if an active ruleset exists
        branches.push({name: "20*.*", protection: null});
      };

      // Skip existing rulesets with the name "ESR" or "Default" as we are reapplying them
      // and duplicates are not allowed
      if (["ESR","Default"].includes(rulesetResponse.data.name)) {
        continue;
      }

      rulesets.push(rulesetResponse.data);
    }
  } catch (error) {
    // ignore errors
    console.error(error);
  }

  if (rulesets.length < 1) {
    // Skip repositories without rulesets
    return;
  }

  const jsonData = {};
  jsonData.rulesets = rulesets;

  if (branches.length > 0) {
    jsonData.branches = branches;
  }

  const filePath = path.join(reposDir, `${repoName}.yml`);

  // Retain any existing props from the repo settings file that are not rulesets or branches
  if (fs.existsSync(filePath)) {
    const existingData = yaml.parse(fs.readFileSync(filePath, "utf8"));
    for (const key in existingData) {
      if (!["rulesets", "branches"].includes(key)) {
        jsonData[key] = existingData[key];
      }
    }
  }

  const yamlData = yaml.stringify(jsonData);
  fs.writeFileSync(filePath, yamlData, "utf8");
}

async function fetchRepoSettings() {
  if (!fs.existsSync(reposDir)) {
    fs.mkdirSync(reposDir);
  }

  if (specificRepo) {
    // Process a specific repository
    await processRepository(specificRepo);
  } else {
    // Process all repositories in the organization
    for await (const response of octokit.paginate.iterator(
      octokit.rest.repos.listForOrg,
      {
        org,
        type: "all",
      }
    )) {
      for (const repo of response.data) {
        await processRepository(repo.name);
      }
    }
  }

  console.log("Repository settings processing complete.");
}

async function main() {
  // replace the file at orgSettingsPath with the one bundled with this npm package
  // const yamlData = fs.readFileSync(packageSettingsPath, "utf8");
  // fs.writeFileSync(orgSettingsPath, yamlData, "utf8");
  await fetchRepoSettings();
}

main();

function protectionDataToRuleset(protectionData, branch) {
  const ruleset = {
    name: branch.name,
    target: "branch",
    enforcement: "active",
    conditions: {
      ref_name: {
        exclude: [],
        include: [branch.include],
      },
    },
    rules: [],
    bypass_actors: [
      {
        actor_id: 1,
        actor_type: "OrganizationAdmin",
        bypass_mode: "always",
      },
      {
        actor_id: 5,
        actor_type: "RepositoryRole",
        bypass_mode: "always",
      },
      {
        actor_id: 291899,
        actor_type: "Integration",
        bypass_mode: "always",
      },
    ],
  };

  // Rule for required status checks
  if (protectionData.required_status_checks) {
    const statusChecksRule = {
      type: "required_status_checks",
      parameters: {
        // strict_required_status_checks_policy:
        //   protectionData.required_status_checks.strict,
        strict_required_status_checks_policy: true,
        required_status_checks:
          protectionData.required_status_checks.checks.map((check) => ({
            context: check.context,
          })),
      },
    };
    ruleset.rules.push(statusChecksRule);
  }

  // // Rule for pull request reviews
  // if (protectionData.required_pull_request_reviews) {
  //   const prReviewsRule = {
  //     type: "pull_request",
  //     parameters: {
  //       required_approving_review_count: 0,
  //       dismiss_stale_reviews_on_push:
  //         protectionData.required_pull_request_reviews.dismiss_stale_reviews,
  //       require_code_owner_review:
  //         protectionData.required_pull_request_reviews
  //           .require_code_owner_reviews,
  //       require_last_push_approval:
  //         protectionData.required_pull_request_reviews
  //           .require_last_push_approval,
  //       required_review_thread_resolution: false, // Set as needed
  //     },
  //   };
  //   ruleset.rules.push(prReviewsRule);
  // }

  return ruleset;
}
