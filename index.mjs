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

// Initialize Octokit with the GitHub token
const octokit = new Octokit({ auth: token });

function branchRuleToNewBranch(query, defaultBranch) {
  const branchData = {
    name: (query.pattern === defaultBranch) ? "default" : query.pattern,
    protection: {
      enforce_admins: query.isAdminEnforced,
      required_pull_request_reviews: null,
      restrictions: null,
      required_status_checks: null,
    },
  };

  if (query.requiresApprovingReviews) {
    branchData.protection.required_pull_request_reviews = {
      required_approving_review_count: query.requiredApprovingReviewCount,
    };
  }

  if (query.requiresStatusChecks) {
    branchData.protection.required_status_checks = {
      strict: query.requiresStrictStatusChecks,
      contexts: query.requiredStatusCheckContexts
    };
  }

  return branchData;
}

async function getBranchProtectionRulesData(owner, repo) {
  const query = `
    query($owner: String!, $repo: String!) {
      repository(owner: $owner, name: $repo) {
        branchProtectionRules(first: 100) {
          nodes {
            pattern
            requiresApprovingReviews
            requiredApprovingReviewCount
            requiresStatusChecks
            requiredStatusCheckContexts
            requiresStrictStatusChecks
            restrictsPushes
            restrictsReviewDismissals
            isAdminEnforced
          }
        }
      }
    }
  `;

  try {
    const result = await octokit.graphql(query, {
      owner: owner,
      repo: repo,
    });

    return result.repository.branchProtectionRules.nodes;
  } catch (error) {
    console.error(error.message);
  }
}

async function getRepoRulesetsData(owner, repo) {
  try {
    const result = await octokit.rest.repos.getRepoRulesets({
      owner: owner,
      repo: repo,
      includes_parents: false,
    });

    return result.data;
  } catch (error) {
    // console.error(error.message);
  }
}

async function getRulesetData(owner, repo, rulesetId) {
  try {
    const result = await octokit.rest.repos.getRepoRuleset({
      owner: owner,
      repo: repo,
      ruleset_id: rulesetId,
    });

    return result.data;
  } catch (error) {
    console.error(error.message);
  }
}

function rulesetDataToNewRuleset(rulesetData) {
  delete rulesetData.id;
  delete rulesetData.source;
  delete rulesetData.source_type;
  delete rulesetData.created_at;
  delete rulesetData.updated_at;
  delete rulesetData.node_id;
  delete rulesetData.current_user_can_bypass;
  delete rulesetData._links;
  return rulesetData;
}

async function getRepoData(owner, repo) {
  try {
    const result = await octokit.rest.repos.get({
      owner: owner,
      repo: repo,
    });

    return result.data;
  } catch (error) {
    console.error(error.message);
  }
}

async function processRepository(repoName) {
  let rulesets = [];
  let branches = [];

  // Fetch repository settings
  const repoData = await getRepoData(org, repoName);

  if (repoData.archived) {
    // Skip archived repositories
    return;
  }

  if ([".github"].includes(repoData.name)) {
    // Skip the .github repository
    return;
  }

  console.log(`Processing repository: ${repoName}`);

  const branchRulesData = await getBranchProtectionRulesData(org, repoName);
  for (const branchRule of branchRulesData || []) {
    const newBranch = branchRuleToNewBranch(branchRule, repoData.default_branch);
    branches.push(newBranch);
  }

  const repoRulesetsData = await getRepoRulesetsData(org, repoName);
  for (const ruleset of repoRulesetsData || []) {
    const rulesetData = await getRulesetData(org, repoName, ruleset.id);
    const newRuleset = rulesetDataToNewRuleset(rulesetData);
    rulesets.push(newRuleset);
  }

  const jsonData = {};

  if (branches.length > 0) {
    jsonData.branches = branches;
  }

  if (rulesets.length > 0) {
    jsonData.rulesets = rulesets;
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

  function isEmptyObject(obj) {
    return Object.keys(obj).length === 0 && obj.constructor === Object;
  }

  // return if jsonData is an empty object
  if (isEmptyObject(jsonData)) {
    return;
  }

  const yamlData = yaml.stringify(jsonData);
  fs.writeFileSync(filePath, yamlData, "utf8");
}

async function main() {
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

main();
