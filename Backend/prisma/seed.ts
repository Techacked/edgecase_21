/** Seeds the three policies as DEMO SEED CONFIGURATION. Never seeds simulation results. */
import { PrismaClient } from '@prisma/client';
import { POLICY_DEFINITIONS } from '../src/config/policy-definitions';

const prisma = new PrismaClient();

async function main() {
  for (const def of POLICY_DEFINITIONS) {
    const policy = await prisma.policy.upsert({
      where: { slug: def.slug },
      update: { name: def.name, description: def.description },
      create: { slug: def.slug, name: def.name, description: def.description },
    });
    const existing = await prisma.policyVersion.findUnique({ where: { policyId_version: { policyId: policy.id, version: 1 } } });
    if (existing) continue;
    await prisma.$transaction(async (tx) => {
      const version = await tx.policyVersion.create({
        data: { policyId: policy.id, version: 1, model: JSON.parse(JSON.stringify(def.model)), sourceText: 'DEMO SEED CONFIGURATION' },
      });
      await tx.rule.createMany({
        data: def.rules.map((r) => ({
          policyVersionId: version.id, ruleCode: r.ruleCode, description: r.description, type: r.type,
          normalizedConstraint: JSON.parse(JSON.stringify(r.constraint)), confidence: 1, sourceText: r.sourceText,
          verificationStatus: 'VERIFIED' as const, enabled: true,
        })),
      });
    });
  }
  console.log(`Seeded ${POLICY_DEFINITIONS.length} policies (DEMO SEED CONFIGURATION).`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
