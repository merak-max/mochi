import { type Agent, defineExtension, type Extension, section } from "@earendil-works/pi-durable";
import type { ChannelProfile } from "../channels/types.ts";
import { type ChatUser, OWNER_ID } from "../config.ts";
import { prompt } from "../prompts.ts";

/**
 * Two stable sections. `system` holds the facts and rules, the memory folder, and each running channel's bubble style.
 * For every agent-seat conversation it also names the home tools folder and the configured users by id. `identity`
 * holds the voice: who mochi is and the reply style. Root, its forks and its agents render the same bytes, so a fork's
 * first request reuses root's cached prompt.
 */
export function identityExtension(profiles: readonly ChannelProfile[], users: readonly ChatUser[], toolsDir: string, memoryDir: string): Extension {
	const systemParts = [prompt("brain/system", { "memory-dir": memoryDir })];
	for (const profile of profiles) systemParts.push(prompt(`channels/${profile.id}`));
	const everySeatSystem = systemParts.join("\n\n");
	const agentParts = [...systemParts, prompt("brain/agent-system"), prompt("brain/new-tools", { "tools-dir": toolsDir })];
	if (users.length > 0) {
		const people = [`${OWNER_ID}: the owner`];
		for (const user of users) people.push(user.name === undefined ? `${user.id} (iMessage)` : `${user.id}: ${user.name} (iMessage)`);
		agentParts.push(prompt("brain/people", { people: people.join("; ") }));
	}
	const agentSystem = agentParts.join("\n\n");
	const system = (agent: Agent): string => (agent.extensions.some((extension) => extension.name === "seat-agent") ? agentSystem : everySeatSystem);
	return defineExtension({
		name: "identity",
		sections: [section("system", ({ agent }) => system(agent)), section("identity", () => prompt("brain/identity"))],
	});
}
