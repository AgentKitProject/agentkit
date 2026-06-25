import { requireForgeUser } from "./forge-auth.ts";
import { forgeSubmissionException } from "./forge-route-errors.ts";
import { getPublicProfileForUser } from "./profile/profile-client.ts";

export async function getForgePublisherProfile(request: Request) {
  try {
    const forgeUser = await requireForgeUser(request);
    const profile = await getPublicProfileForUser(forgeUser.id);

    return Response.json({
      displayName: profile.displayName,
      handle: profile.handle,
      avatarInitials: profile.avatarInitials,
      verified: profile.verified
    });
  } catch (error) {
    return forgeSubmissionException(error, "/api/forge/publisher-profile");
  }
}
