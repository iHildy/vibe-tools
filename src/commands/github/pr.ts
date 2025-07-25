import type { Command, CommandGenerator } from '../../types.ts';
import { loadEnv } from '../../config.ts';
import { getRepoContext, type GithubOptions } from './utils.ts';
import { getGitHubHeaders, isGitHubCliAvailable, getGitCredentials } from './githubAuth.ts';

interface ReviewComment {
  path: string;
  position: number | null;
  line?: number;
  body: string;
  user: { login: string };
  created_at: string;
  html_url: string;
  state?: 'PENDING' | 'SUBMITTED' | 'RESOLVED';
}

export class PrCommand implements Command {
  constructor() {
    loadEnv();
  }

  private async fetchComments(owner: string, repo: string, prNumber: number): Promise<any[]> {
    const url = `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`;
    try {
      const response = await fetch(url, {
        headers: getGitHubHeaders(),
      });

      if (!response.ok) {
        return [];
      }

      return await response.json();
    } catch (error) {
      console.error('Error fetching comments:', error);
      return [];
    }
  }

  private async fetchReviewComments(
    owner: string,
    repo: string,
    prNumber: number
  ): Promise<ReviewComment[]> {
    const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/comments`;
    try {
      const response = await fetch(url, {
        headers: getGitHubHeaders(),
      });

      if (!response.ok) {
        return [];
      }

      return await response.json();
    } catch (error) {
      console.error('Error fetching review comments:', error);
      return [];
    }
  }

  private formatDate(dateStr: string): string {
    return new Date(dateStr).toLocaleString();
  }

  private groupReviewCommentsByFile(comments: ReviewComment[]): Map<string, ReviewComment[]> {
    const grouped = new Map<string, ReviewComment[]>();
    for (const comment of comments) {
      const existing = grouped.get(comment.path) || [];
      existing.push(comment);
      grouped.set(comment.path, existing);
    }
    return grouped;
  }

  async *execute(query: string, options?: GithubOptions): CommandGenerator {
    const repoContext = await getRepoContext(options);
    if (!repoContext) {
      yield 'Could not determine repository context. Please run this command inside a GitHub repository, or specify the repository with --from-github owner/repo or --repo owner/repo.';
      return;
    }
    const { owner, repo } = repoContext;

    // Check if we have GitHub authentication
    const credentials = getGitCredentials();
    if (!process.env.GITHUB_TOKEN && !isGitHubCliAvailable() && !credentials) {
      yield 'Note: No GitHub authentication found. Using unauthenticated access (rate limits apply).\n';
      yield 'To increase rate limits, either:\n';
      yield '1. Set GITHUB_TOKEN in your environment\n';
      yield '2. Install and login to GitHub CLI (gh)\n';
      yield '3. Configure git credentials for github.com\n\n';
    }

    const prNumber = parseInt(query, 10);

    // Determine what sections to show based on flags
    const showReviews = !options?.discussionOnly && !options?.metadataOnly;
    const showDiscussion = !options?.reviewOnly && !options?.metadataOnly;
    const showMetadata = !options?.reviewOnly && !options?.discussionOnly;
    const showLinks = !options?.noLinks;

    let url: string;
    if (isNaN(prNumber)) {
      url = `https://api.github.com/repos/${owner}/${repo}/pulls?state=open&sort=created&direction=desc&per_page=10`;
    } else {
      url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`;
    }

    try {
      const response = await fetch(url, {
        headers: getGitHubHeaders(),
      });

      if (!response.ok) {
        yield `GitHub API Error: ${response.status} - ${response.statusText}`;
        if (response.status === 404) {
          yield `  (PR ${prNumber} not found or repository is private without authentication)`;
        } else if (
          response.status === 403 &&
          response.headers.get('x-ratelimit-remaining') === '0'
        ) {
          yield '\nRate limit exceeded. To increase rate limits, either:\n';
          yield '1. Set GITHUB_TOKEN in your environment\n';
          yield '2. Install and login to GitHub CLI (gh)\n';
        }
        return;
      }

      const data = await response.json();

      if (isNaN(prNumber)) {
        // Listing PRs
        if (data.length === 0) {
          yield 'No open PRs found.';
          return;
        }
        for (const pr of data) {
          const linkText = showLinks ? ` (${pr.html_url})` : '';
          yield `#${pr.number}: ${pr.title} by ${pr.user.login}${linkText}\n`;
        }
      } else {
        // Single PR with full discussion
        const pr = data;

        // PR header (always shown for context)
        yield `#${pr.number}: ${pr.title}\n`;
        yield `State: ${pr.state}\n`;
        if (showLinks) {
          yield `URL: ${pr.html_url}\n\n`;
        } else {
          yield '\n';
        }

        // Original post (always shown for context unless metadata-only)
        if (!options?.metadataOnly) {
          yield `## Pull Request\n`;
          yield `**@${pr.user.login}** opened this pull request on ${this.formatDate(pr.created_at)}\n\n`;
          yield `${pr.body || 'No description provided.'}\n\n`;
        }

        // PR basic info (always shown unless review-only or discussion-only)
        if (showMetadata) {
          yield `Branch: \`${pr.head.ref}\` → \`${pr.base.ref}\`\n`;
          yield `Commits: ${pr.commits}\n`;
          yield `Changed files: ${pr.changed_files || 'N/A'}\n`;
          yield `+${pr.additions} -${pr.deletions}\n\n`;
        }

        // Review comments (comments on code)
        if (showReviews) {
          const reviewComments = await this.fetchReviewComments(owner, repo, prNumber);
          let filteredReviewComments = reviewComments;

          // Filter out resolved comments if requested
          if (options?.hideResolved) {
            filteredReviewComments = reviewComments.filter(
              (comment) => comment.state !== 'RESOLVED'
            );
          }

          if (filteredReviewComments.length > 0) {
            yield `## Code Review Comments (${filteredReviewComments.length} comments)\n`;
            const groupedComments = this.groupReviewCommentsByFile(filteredReviewComments);

            for (const [file, comments] of groupedComments) {
              yield `\n### ${file}\n`;
              for (const comment of comments) {
                yield `\n---\n`;
                yield `**@${comment.user.login}** commented${comment.line ? ` on line ${comment.line}` : ''} on ${this.formatDate(comment.created_at)}\n`;
                yield `${comment.body}\n`;
                if (showLinks) {
                  yield `[View in GitHub](${comment.html_url})\n`;
                }
              }
            }
            yield '\n';
          } else {
            if (reviewComments.length > 0 && options?.hideResolved) {
              yield `\nNo unresolved code review comments.\n`;
            } else {
              yield `\nNo code review comments yet.\n`;
            }
          }
        }

        // Discussion comments
        if (showDiscussion) {
          const comments = await this.fetchComments(owner, repo, prNumber);
          if (comments.length > 0) {
            yield `## Discussion (${comments.length} comments)\n`;
            for (const comment of comments) {
              yield `\n---\n`;
              yield `**@${comment.user.login}** commented on ${this.formatDate(comment.created_at)}\n\n`;
              yield `${comment.body || 'No content'}\n`;
            }
          } else {
            yield `\nNo discussion comments yet.\n`;
          }
        }

        // Additional PR metadata
        if (showMetadata) {
          yield `\n---\n`;
          yield `Labels: ${pr.labels.map((l: { name: string }) => l.name).join(', ') || 'None'}\n`;
          if (pr.assignees?.length > 0) {
            yield `Assignees: ${pr.assignees.map((a: { login: string }) => '@' + a.login).join(', ')}\n`;
          }
          if (pr.milestone) {
            yield `Milestone: ${pr.milestone.title}\n`;
          }
          if (pr.requested_reviewers?.length > 0) {
            yield `Requested Reviewers: ${pr.requested_reviewers.map((r: { login: string }) => '@' + r.login).join(', ')}\n`;
          }
        }
      }
    } catch (error) {
      yield `Error fetching PRs: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  }
}
