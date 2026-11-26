import type { GroupStyle } from "./catalog.js";

/**
 * Ready-made boundary boxes in each provider's diagram style (AWS architecture icons,
 * Azure, Kubernetes, on-prem). They are documentation-only groups (generic.group) with an
 * icon and a style; GCP's deployable groups (project, region, VPC, subnet) have their own kinds.
 */
export interface GroupPreset {
  label: string;
  /** Icon reference ("aws:Region", "lucide:network"…); none for title-only boxes. */
  icon?: string;
  style: Partial<GroupStyle> & { color: string };
  hint: string;
}

const AWS_BLUE = "#147eba";
const AWS_GREEN = "#248814";

export const AWS_GROUPS: GroupPreset[] = [
  { label: "AWS Cloud", icon: "aws:AWSCloud", style: { color: "#232f3e", border: "solid", borderWidth: "1", header: "tab" }, hint: "aws cloud boundary amazon" },
  { label: "AWS account", icon: "aws:AWSAccount", style: { color: "#e7157b", border: "solid", borderWidth: "1", header: "tab" }, hint: "aws account amazon" },
  { label: "Region", icon: "aws:Region", style: { color: AWS_BLUE, border: "solid", borderWidth: "1", header: "tab" }, hint: "aws region amazon" },
  { label: "Availability Zone", style: { color: AWS_BLUE, border: "dashed", borderWidth: "1", header: "center" }, hint: "aws availability zone az" },
  { label: "VPC", icon: "aws:VirtualprivatecloudVPC", style: { color: AWS_GREEN, border: "solid", borderWidth: "1", header: "tab" }, hint: "aws vpc virtual private cloud network" },
  { label: "Public subnet", icon: "aws:Publicsubnet", style: { color: AWS_GREEN, border: "none", fill: "#e9f3e6", header: "tab" }, hint: "aws public subnet" },
  { label: "Private subnet", icon: "aws:Privatesubnet", style: { color: AWS_BLUE, border: "none", fill: "#e6f2f8", header: "tab" }, hint: "aws private subnet" },
  { label: "Security group", style: { color: "#df3312", border: "solid", borderWidth: "1", header: "label" }, hint: "aws security group firewall" },
  { label: "Auto Scaling group", icon: "aws:AutoScalinggroup", style: { color: "#d86613", border: "dashed", borderWidth: "1", header: "tab" }, hint: "aws auto scaling group asg" },
  { label: "Spot Fleet", icon: "aws:SpotFleet", style: { color: "#d86613", border: "solid", borderWidth: "1", header: "tab" }, hint: "aws spot fleet ec2" },
  { label: "Corporate data center", icon: "aws:Corporatedatacenter", style: { color: "#7d8998", border: "solid", borderWidth: "1", header: "tab" }, hint: "corporate data center on-prem" },
  { label: "Server contents", icon: "aws:Servercontents", style: { color: "#7d8998", border: "solid", borderWidth: "1", header: "tab" }, hint: "server contents on-prem host" },
];

const AZURE = "#0078d4";
const K8S = "#326ce5";

export const OTHER_GROUPS: GroupPreset[] = [
  { label: "Azure subscription", icon: "logos:microsoft-azure", style: { color: AZURE, border: "solid", borderWidth: "1", header: "tab" }, hint: "azure subscription microsoft" },
  { label: "Resource group", icon: "lucide:boxes", style: { color: AZURE, border: "dashed", borderWidth: "1", header: "tab" }, hint: "azure resource group" },
  { label: "Virtual network", icon: "lucide:network", style: { color: AZURE, border: "solid", borderWidth: "1", header: "tab" }, hint: "azure vnet virtual network" },
  { label: "Azure subnet", icon: "lucide:lock", style: { color: AZURE, border: "none", fill: "#e6f2f8", header: "tab" }, hint: "azure subnet" },
  { label: "Zone", style: { color: "#5f6368", border: "dashed", borderWidth: "1", header: "center" }, hint: "availability zone gcp azure zone" },
  { label: "Kubernetes cluster", icon: "logos:kubernetes", style: { color: K8S, border: "solid", borderWidth: "1.5", header: "tab" }, hint: "kubernetes k8s cluster eks aks gke openshift" },
  { label: "Namespace", icon: "lucide:box", style: { color: K8S, border: "dashed", borderWidth: "1", header: "tab" }, hint: "kubernetes namespace k8s" },
  { label: "On-prem data center", icon: "lucide:building", style: { color: "#5f6368", border: "solid", borderWidth: "2", header: "tab" }, hint: "on-prem data center datacenter colo site" },
  { label: "Corporate network", icon: "lucide:network", style: { color: "#5f6368", border: "dashed", borderWidth: "1", header: "tab" }, hint: "corporate network lan intranet office" },
  { label: "DMZ", icon: "lucide:shield", style: { color: "#d93025", border: "dashed", borderWidth: "1.5", header: "tab" }, hint: "dmz perimeter zone" },
  { label: "VMware / private cloud", icon: "logos:vmware", style: { color: "#607078", border: "solid", borderWidth: "1", header: "tab" }, hint: "vmware vsphere private cloud on-prem" },
  { label: "Team / boundary", style: { color: "#71717a", border: "dotted", borderWidth: "1.5", header: "label" }, hint: "team boundary environment group" },
];

/** Style for an AWS group icon from the bundled pack, so its tile draws in AWS's style. */
export function awsGroupStyle(iconName: string): GroupPreset["style"] | undefined {
  return AWS_GROUPS.find((g) => g.icon === `aws:${iconName}`)?.style;
}

/** The pack icons that already are a coloured tab (drawn as-is, not on a coloured square). */
export const TAB_ICONS = new Set(AWS_GROUPS.map((g) => g.icon).filter(Boolean) as string[]);

/** draw.io's AWS group icons (grIcon=mxgraph.aws4.…) ↔ the bundled AWS pack. */
export const DRAWIO_AWS_GROUP: Record<string, string> = {
  group_aws_cloud: "AWSCloud",
  group_aws_cloud_alt: "AWSCloud",
  group_account: "AWSAccount",
  group_region: "Region",
  group_vpc: "VirtualprivatecloudVPC",
  group_vpc2: "VirtualprivatecloudVPC",
  group_auto_scaling_group: "AutoScalinggroup",
  group_spot_fleet: "SpotFleet",
  group_corporate_data_center: "Corporatedatacenter",
  group_on_premise: "Servercontents",
};
