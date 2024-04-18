#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const yaml = require("yaml");

const directoryPath = path.join(process.cwd(), ".github", "repos");

// Read all files in the directory
fs.readdir(directoryPath, (err, files) => {
  if (err) {
    return console.log("Unable to scan directory: " + err);
  }

  files.forEach((file) => {
    if (file.endsWith(".yml")) {
      const filePath = path.join(directoryPath, file);

      // Read each YAML file
      fs.readFile(filePath, "utf8", (err, data) => {
        if (err) {
          return console.log("Error reading file:", filePath, err);
        }

        try {
          const doc = yaml.parse(data);

          // Modify the document as per the requirements
          if (doc.rulesets && doc.rulesets.length > 0) {
            const newStructure = {
              branches: [
                {
                  name: "default",
                  protection: {
                    enforce_admins: false,
                    required_pull_request_reviews: null,
                    restrictions: null,
                    required_status_checks: {
                      strict: true,
                      contexts: doc.rulesets[0].rules
                        .filter(
                          (rule) => rule.type === "required_status_checks"
                        )
                        .flatMap((rule) =>
                          rule.parameters.required_status_checks.map(
                            (check) => check.context
                          )
                        ),
                    },
                  },
                },
              ],
              rulesets: doc.rulesets.map((ruleset) => ({
                name: "Default",
                target: ruleset.target,
                enforcement: "evaluate",
                conditions: ruleset.conditions,
                rules: [
                  {
                    type: "pull_request",
                    parameters: {
                      required_approving_review_count: 0,
                      dismiss_stale_reviews_on_push: false,
                      require_code_owner_review: false,
                      require_last_push_approval: false,
                      required_review_thread_resolution: false,
                    },
                  },
                  {
                    type: "required_status_checks",
                    parameters: {
                      strict_required_status_checks_policy: true,
                      required_status_checks: ruleset.rules
                        .filter(
                          (rule) => rule.type === "required_status_checks"
                        )
                        .flatMap((rule) =>
                          rule.parameters.required_status_checks.map(
                            (check) => { return { context: check.context } }
                          )
                        ),
                    },
                  }
                ],
                bypass_actors: ruleset.bypass_actors,
              })),
            };

            // Write the new YAML content back to the same file
            const newYamlContent = yaml.stringify(newStructure);
            fs.writeFile(filePath, newYamlContent, "utf8", (err) => {
              if (err) {
                return console.log("Error writing file:", filePath, err);
              }
              console.log("Successfully updated file:", filePath);
            });
          }
        } catch (e) {
          console.log("Error parsing YAML file:", filePath, e);
        }
      });
    }
  });
});
