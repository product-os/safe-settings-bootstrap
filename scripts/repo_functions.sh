#!/bin/bash

remove_custom_merge_settings() {
    yq e 'del(.repository.allow_squash_merge)' -i "$1"
    yq e 'del(.repository.allow_merge_commit)' -i "$1"
    yq e 'del(.repository.allow_rebase_merge)' -i "$1"
    yq e 'del(.repository.allow_auto_merge)' -i "$1"
    yq e 'del(.repository.delete_branch_on_merge)' -i "$1"
}

remove_review_count() {
    yq e 'del(.branches[].protection.required_pull_request_reviews.required_approving_review_count)' -i "$1"
    yq e 'del(.branches[].protection.required_status_checks.contexts[] | select(. | test("policy-bot: ")))' -i "$1"
}

remove_legacy_checks() {
    # Use yq to delete the unwanted contexts and check if the contexts array is empty
    yq e 'del(.branches[].protection.required_status_checks.contexts[] | select(. | test("^(ResinCI|VersionBot)")))' -i "$1"
}

create_flowzone_suborg() {
    if [ ! -f "$(pwd)"/.github/suborgs/required_status_checks.flowzone.yml ]; then
        exit 1
    fi

    if [ -n "$(yq e '.branches[].protection.required_status_checks.contexts[] | select(test("^Flowzone "))' "$1")" ]; then
        # Append the repo to the list
        yq e ".suborgrepos += [\"$(basename "$1" .yml)\"]" -i "$(pwd)"/.github/suborgs/required_status_checks.flowzone.yml
    fi

    yq e 'del(.branches[].protection.required_status_checks.contexts[] | select(. | test("^Flowzone ")))' -i "$1"
}

create_jenkins_build_suborg() {
    if [ ! -f "$(pwd)"/.github/suborgs/required_status_checks.jenkins-build.yml ]; then
        exit 1
    fi

    if [ -n "$(yq e '.branches[].protection.required_status_checks.contexts[] | select(test("^Jenkins build$"))' "$1")" ]; then
        # Append the repo to the list
        yq e ".suborgrepos += [\"$(basename "$1" .yml)\"]" -i "$(pwd)"/.github/suborgs/required_status_checks.jenkins-build.yml
    fi

    yq e 'del(.branches[].protection.required_status_checks.contexts[] | select(. | test("^Jenkins build$")))' -i "$1"

}

remove_empty() {
    # Remove empty sequences
    yq e 'del(.. | select(tag == "!!seq" and length == 0))' -i "$1"

    # Remove empty maps
    yq e 'del(.. | select(tag == "!!map" and length == 0))' -i "$1"

    yq e 'del(.branches[] | select(.protection == null))' -i "$1"
}

for file in "$(pwd)"/.github/repos/*.yml; do
    "$1" "$file"
    remove_empty "$file"
    remove_empty "$file"
    remove_empty "$file"
    remove_empty "$file"
    if [ "$(yq e '.' "$file")" = "{}" ]; then
        rm "$file"
    fi
done
