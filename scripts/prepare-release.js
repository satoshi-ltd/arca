// Reuse only a draft belonging to this checkout; never mix release builds.
export async function prepareRelease({ github, repo, tag, sha }) {
  const releases = await github.paginate(github.rest.repos.listReleases, {
    ...repo,
    per_page: 100,
  });
  const release = releases.find((item) => item.tag_name === tag);
  if (release && !release.draft) return false;
  if (release && release.target_commitish !== sha)
    throw new Error(
      `Draft ${tag} belongs to another commit; inspect it before retrying`,
    );
  let ref;
  try {
    ref = (await github.rest.git.getRef({ ...repo, ref: `tags/${tag}` })).data;
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  if (ref && (!release || ref.object.sha !== sha))
    throw new Error(
      `Tag ${tag} already exists outside this draft; refusing to overwrite it`,
    );
  if (!release)
    await github.rest.repos.createRelease({
      ...repo,
      tag_name: tag,
      target_commitish: sha,
      name: `Arca ${tag} alpha`,
      body: "Build and verification in progress. Not ready for distribution.",
      draft: true,
      prerelease: true,
    });
  return true;
}
