#!/bin/bash

# Variables
# OWNER="owner"         # replace with repository owner's username
# REPO="repo"           # replace with repository name
# PR_NUMBER="pr_number" # replace with PR number
# USERNAME="username"   # replace with the username of the commenter

# shellcheck source=/dev/null
source "$(dirname "$0")/.env"

export GH_PAGER=cat
export GH_PROMPT_DISABLED=true

# Fetch all comments on the PR
comments=$(gh api --paginate "/repos/$OWNER/$REPO/issues/$PR_NUMBER/comments")

# Loop through each comment
echo "$comments" | jq -r '.[] | @base64' | while read comment; do
    # Decode the comment
    comment=$(echo "$comment" | base64 --decode)

    # Get the username of the commenter
    commenter=$(echo "$comment" | jq -r '.user.login')

    # If the commenter is the user we're looking for
    if [ "$commenter" == "$USERNAME" ]; then
        # Get the comment ID
        comment_id=$(echo "$comment" | jq -r '.id')

        echo "Deleting comment $comment_id..."
        gh api --method DELETE -H "Accept: application/vnd.github+json" "/repos/$OWNER/$REPO/issues/comments/$comment_id" | cat
    fi
done
