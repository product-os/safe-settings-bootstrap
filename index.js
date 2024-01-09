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
const reposDir = "./repos";
const defaultSettingsPath = "./defaults.yml";

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

// Read the default settings from the YAML file
const defaultSettings = yaml.parse(
  fs.readFileSync(defaultSettingsPath, "utf8")
);

function flattenEnabledProperty(obj) {
  for (const key in obj) {
    if (obj.hasOwnProperty(key) && obj[key] && typeof obj[key] === "object") {
      if (Object.keys(obj[key]).length === 1 && "enabled" in obj[key]) {
        // Flatten to just the 'enabled' value
        obj[key] = obj[key].enabled;
      } else {
        // Recursively process nested objects
        flattenEnabledProperty(obj[key]);
      }
    }
  }
}

function removeSpecificProperties(obj, pathsToRemove) {
  pathsToRemove.forEach((path) => {
    const parts = path.split(".");
    let current = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (current[parts[i]]) {
        current = current[parts[i]];
      } else {
        return; // Path not found, nothing to remove
      }
    }
    delete current[parts[parts.length - 1]];
  });
}

function arraysEqual(arr1, arr2) {
  if (arr1.length !== arr2.length) return false;

  const frequencyCounter1 = arr1.reduce((acc, val) => {
    acc[val] = (acc[val] || 0) + 1;
    return acc;
  }, {});

  const frequencyCounter2 = arr2.reduce((acc, val) => {
    acc[val] = (acc[val] || 0) + 1;
    return acc;
  }, {});

  for (let key in frequencyCounter1) {
    if (frequencyCounter1[key] !== frequencyCounter2[key]) {
      return false;
    }
  }

  return true;
}

function compareObjects(template, actual) {
  const diff = {};
  let hasDiff = false;
  for (const key in template) {
    if (!template.hasOwnProperty(key)) continue;

    // console.error(actual);

    if (Array.isArray(template[key]) && actual[key]) {
      // Compare arrays (lists) as unordered
      if (!arraysEqual(template[key].sort(), actual[key].sort())) {
        diff[key] = actual[key];
        hasDiff = true;
      }
    } else if (
      typeof template[key] === "object" &&
      template[key] !== null &&
      actual[key]
    ) {
      // Deep comparison for objects
      const nestedDiff = compareObjects(template[key], actual[key]);
      if (nestedDiff) {
        diff[key] = nestedDiff;
        hasDiff = true;
      }
    } else if (actual.hasOwnProperty(key) && template[key] !== actual[key]) {
      diff[key] = actual[key];
      hasDiff = true;
    }
  }
  return hasDiff ? diff : null;
}

async function processRepository(octokit, repoName) {
  let repoSettingsDiff;
  let branchProtectionDiff = [];

  // Fetch repository settings
  const repoData = await octokit.rest.repos.get({ owner: org, repo: repoName });

  if (repoData.data.archived) {
    // Skip archived repositories
    return;
  }

  flattenEnabledProperty(repoData.data);

  repoSettingsDiff = compareObjects(defaultSettings.repository, repoData.data);

  for (const defaultBranch of defaultSettings.branches) {
    try {
      const protectionData = await octokit.rest.repos.getBranchProtection({
        owner: org,
        repo: repoName,
        branch: defaultBranch.name,
      });

      // Remove specific properties
      removeSpecificProperties(protectionData.data, [
        "required_status_checks.checks",
        "required_status_checks.url",
        "required_status_checks.contexts_url",
        "required_pull_request_reviews.url",
        "required_pull_request_reviews.dismissal_restrictions.url",
        "required_pull_request_reviews.dismissal_restrictions.teams_url",
        "required_pull_request_reviews.dismissal_restrictions.users_url",
        "enforce_admins.url",
        // Add more paths to remove here as needed
      ]);

      flattenEnabledProperty(protectionData);

      const protectionOutput = compareObjects(
        defaultBranch.protection,
        protectionData.data
      );

      if (protectionOutput) {
        branchProtectionDiff.push({
          name: defaultBranch.name,
          protection: protectionOutput,
        });
      }
    } catch (error) {
      // ignore error
    }
  }

  // Write YAML file if differences are found
  if (repoSettingsDiff || branchProtectionDiff.length > 0) {
    const jsonData = {};
    if (repoSettingsDiff) {
      jsonData.repository = repoSettingsDiff;
    }
    if (branchProtectionDiff.length > 0) {
      jsonData.branches = branchProtectionDiff;
    }
    const yamlData = yaml.stringify(jsonData);
    fs.writeFileSync(`./repos/${repoName}.yml`, yamlData, "utf8");
  }
}

async function main() {
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

main();
