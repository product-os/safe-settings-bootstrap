#!/usr/bin/env node
require("dotenv").config();
const { Probot, ProbotOctokit } = require("probot");
const { throttling } = require("@octokit/plugin-throttling");
const yaml = require("yaml");
const fs = require("fs");
const path = require("path");

// Load the GitHub Personal Access Token and organization name from environment variables
const token = process.env.GITHUB_TOKEN;
const org = process.env.ORG_NAME;
const specificRepo = process.env.SPECIFIC_REPO; // Optionally set this to run on a single repo
const reposDir = path.join(process.cwd(), ".github", "repos");
const orgSettingsPath = path.join(process.cwd(), ".github", "settings.yml");
const packageSettingsPath = path.join(__dirname, 'assets', 'settings.yml');

// Apply throttling plugin to Octokit
const ThrottledOctokit = ProbotOctokit.plugin(throttling);

// Initialize a Probot instance with a custom Octokit class
const probot = new Probot({
  appId: 12345, // Dummy App ID, not used in PAT authentication
  githubToken: token,
  Octokit: ThrottledOctokit.defaults({
    auth: `token ${token}`,
    throttle: {
      onRateLimit: (retryAfter, options) => {
        console.warn(
          `Request quota exhausted for request ${options.method} ${options.url}`
        );
        if (options.request.retryCount === 0) {
          // only retries once
          console.log(`Retrying after ${retryAfter} seconds!`);
          return true;
        }
      },
      onSecondaryRateLimit: (retryAfter, options) => {
        console.warn(
          `Secondary rate limit hit for request ${options.method} ${options.url}`
        );
      },
    },
  }),
});

async function processRepository(octokit, repoName) {
  let rulesets = [];

  // Fetch repository settings
  const repoData = await octokit.rest.repos.get({ owner: org, repo: repoName });

  if (repoData.data.archived) {
    // Skip archived repositories
    return;
  }

  if (['.github'].includes(repoData.data.name)) {
    // Skip the .github repository
    return;
  }

  console.log(`Processing repository: ${repoName}`);

  try {
    const protectionData = await octokit.rest.repos.getBranchProtection({
      owner: org,
      repo: repoName,
      branch: repoData.data.default_branch,
    });

    const rulesetData = convertBranchProtectionToRuleset(protectionData.data);

    // Remove 'policy-bot' contexts and filter out rules without contexts
    rulesetData.rules = rulesetData.rules
      .map((rule) => {
        if (rule.type === "required_status_checks") {
          rule.parameters.required_status_checks =
            rule.parameters.required_status_checks.filter(
              (check) =>
                !check.context.startsWith("policy-bot") &&
                !check.context.startsWith("VersionBot") &&
                !check.context.startsWith("ResinCI")
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
  } catch (error) {
    // Skip repositories without rulesets
    return;
  }

  if (rulesets.length < 1) {
    // Skip repositories without rulesets
    return;
  }

  const jsonData = {};
  jsonData.rulesets = rulesets;

  const yamlData = yaml.stringify(jsonData);
  const filePath = path.join(reposDir, `${repoName}.yml`);
  fs.writeFileSync(filePath, yamlData, "utf8");
}

async function fetchRepoSettings() {
  const octokit = await probot.auth();
  if (!fs.existsSync(reposDir)) {
    fs.mkdirSync(reposDir);
  }

  if (specificRepo) {
    // Process a specific repository
    await processRepository(octokit, specificRepo);
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
        await processRepository(octokit, repo.name);
      }
    }
  }

  console.log("Repository settings processing complete.");
}

async function main() {
  // replace the file at orgSettingsPath with the one bundled with this npm package
  const yamlData = fs.readFileSync(packageSettingsPath, 'utf8');
  fs.writeFileSync(orgSettingsPath, yamlData, "utf8");
  await fetchRepoSettings();
}

main();

function convertBranchProtectionToRuleset(branchProtection) {
  const ruleset = {
    name: "Default",
    target: "branch",
    enforcement: "active",
    conditions: {
      ref_name: {
        exclude: [],
        include: ["~DEFAULT_BRANCH"],
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
  if (branchProtection.required_status_checks) {
    const statusChecksRule = {
      type: "required_status_checks",
      parameters: {
        // strict_required_status_checks_policy:
        //   branchProtection.required_status_checks.strict,
        strict_required_status_checks_policy: true,
        required_status_checks:
          branchProtection.required_status_checks.checks.map((check) => ({
            context: check.context,
            integration_id: check.app_id || 15368,
          })),
      },
    };
    ruleset.rules.push(statusChecksRule);
  }

  // // Rule for pull request reviews
  // if (branchProtection.required_pull_request_reviews) {
  //   const prReviewsRule = {
  //     type: "pull_request",
  //     parameters: {
  //       required_approving_review_count: 0,
  //       dismiss_stale_reviews_on_push:
  //         branchProtection.required_pull_request_reviews.dismiss_stale_reviews,
  //       require_code_owner_review:
  //         branchProtection.required_pull_request_reviews
  //           .require_code_owner_reviews,
  //       require_last_push_approval:
  //         branchProtection.required_pull_request_reviews
  //           .require_last_push_approval,
  //       required_review_thread_resolution: false, // Set as needed
  //     },
  //   };
  //   ruleset.rules.push(prReviewsRule);
  // }

  // Add other rules based on branchProtection object as needed

  return ruleset;
}
