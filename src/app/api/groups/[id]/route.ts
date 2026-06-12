import authOptions from "lib/auth";
import { prisma } from "lib/prisma";
import ResponseDTO from "lib/response";
import { getServerSession } from "next-auth";
import validator from "validator";

export async function DELETE(req: Request) {
  const session = await getServerSession(authOptions);

  if (!session) {
    return ResponseDTO.status(401).json({
      result: false,
      error: {
        title: "Unauthorized",
        message: "You are not authorized to perform this action",
      },
    });
  }

  const user = await prisma.user.findUnique({
    where: {
      id: session.user.id,
    },
    include: {
      groups: true,
    },
  });

  if (!user || !user.groups.find((g) => g.name === "Admin")) {
    return ResponseDTO.status(403).json({
      result: false,
      error: {
        title: "Forbidden",
        message: "You are not authorized to perform this action",
      },
    });
  }

  const url = new URL(req.url);
  const id = url.pathname.split("/").pop();

  if (!id || !validator.isUUID(id)) {
    return ResponseDTO.status(400).json({
      result: false,
      error: {
        title: "Bad Request",
        message: "Invalid request body",
      },
    });
  }

  const group = await prisma.group.findUnique({
    where: {
      id,
    },
  });

  if (!group) {
    return ResponseDTO.status(404).json({
      result: false,
      error: {
        title: "Not Found",
        message: "Group not found",
      },
    });
  }

  if (group.name === "Admin") {
    return ResponseDTO.status(400).json({
      result: false,
      error: {
        title: "Bad Request",
        message: "Admin group cannot be deleted",
      },
    });
  }

  await prisma.group.delete({
    where: {
      id,
    },
  });

  return ResponseDTO.status(200).json({
    result: true,
  });
}
